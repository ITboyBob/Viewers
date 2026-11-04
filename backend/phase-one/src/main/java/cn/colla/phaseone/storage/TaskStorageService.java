package cn.colla.phaseone.storage;

import cn.colla.phaseone.dashboard.DashboardTargetResolver;
import cn.colla.phaseone.identity.IdentityRepository;
import cn.colla.phaseone.shared.ApiException;
import cn.colla.phaseone.task.TaskDtos.*;
import cn.colla.phaseone.task.TaskRegistrationService;
import cn.colla.phaseone.task.TaskRepository;
import cn.colla.phaseone.team.TeamPolicy;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import java.io.*;
import java.nio.file.*;
import java.security.*;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** 文件只属于本次后端实例；数据库存关联、修订及幂等确认，文件名不参与路径构造。 */
@Service
public class TaskStorageService {
  public record SourceFile(
      String file_id,
      int selection_index,
      String file_name,
      String relative_path,
      long size,
      String study_uid,
      String series_uid,
      String sop_uid) {}

  public record StartImport(
      String registration_key,
      String title,
      String kind,
      String folder_name,
      String mode_path,
      List<SourceFile> files) {}

  public record ImportView(String import_id, List<String> uploaded_files) {}

  public record Access(String owner_uid, boolean can_edit) {}

  public record Materials(Task task, StartImport source, Access access) {}

  public record ResultObject(String object_id, String type) {}

  public record Commit(long base_revision, String operation_id, List<ResultObject> objects) {}

  public record Results(long revision, List<ResultObject> objects, Access access) {}

  private record ImportRow(String uid, String team, String manifest, String taskId) {}

  private record Blob(Path path, long size, String hash, String actor) {}

  private final JdbcTemplate jdbc;
  private final TeamPolicy teams;
  private final TaskRepository tasks;
  private final TaskRegistrationService registrations;
  private final ObjectMapper json;
  private final Clock clock;
  private final Path root;
  private final java.util.concurrent.atomic.AtomicLong occupied =
      new java.util.concurrent.atomic.AtomicLong();
  private final Map<String, Blob> blobs = new ConcurrentHashMap<>();
  private final Map<String, Object> locks = new ConcurrentHashMap<>();
  private final long maxFile, maxStudy, maxRuntime;

  public TaskStorageService(
      JdbcTemplate jdbc,
      TeamPolicy teams,
      TaskRepository tasks,
      TaskRegistrationService registrations,
      ObjectMapper json,
      Clock clock,
      @Value("${colla.storage.max-file-bytes:536870912}") long maxFile,
      @Value("${colla.storage.max-study-bytes:2147483648}") long maxStudy,
      @Value("${colla.storage.max-runtime-bytes:17179869184}") long maxRuntime)
      throws IOException {
    this.jdbc = jdbc;
    this.teams = teams;
    this.tasks = tasks;
    this.registrations = registrations;
    this.json = json;
    this.clock = clock;
    if (maxFile < 1 || maxStudy < maxFile || maxRuntime < maxStudy)
      throw new IllegalArgumentException("文件容量配置无效");
    this.maxFile = maxFile;
    this.maxStudy = maxStudy;
    this.maxRuntime = maxRuntime;
    root = Files.createTempDirectory("colla-task-runtime-");
  }

  private Object lock(String key) {
    return locks.computeIfAbsent(key, k -> new Object());
  }

  public static String uuid(String value) {
    if (value == null) throw ApiException.validation();
    return DashboardTargetResolver.uuid(value);
  }

  public static ApiException missing() {
    return new ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", "资源不存在");
  }

  private static ApiException conflict(String reason) {
    return new ApiException(HttpStatus.CONFLICT, "CONFLICT", "数据发生冲突，请刷新后重试", reason);
  }

  private String encode(Object value) {
    try {
      return json.writeValueAsString(value);
    } catch (Exception error) {
      throw ApiException.validation();
    }
  }

  private <T> T decode(String value, Class<T> type) {
    try {
      return json.readValue(value, type);
    } catch (Exception error) {
      throw new IllegalStateException("存储数据损坏");
    }
  }

  private StartImport manifest(String value) {
    return decode(value, StartImport.class);
  }

  private List<ResultObject> objects(String value) {
    try {
      return json.readValue(
          value, json.getTypeFactory().constructCollectionType(List.class, ResultObject.class));
    } catch (Exception e) {
      throw new IllegalStateException("成果清单损坏");
    }
  }

  private ImportRow importRow(String uid, String id) {
    var row =
        jdbc
            .query(
                "SELECT * FROM task_import WHERE import_id=? AND uid=?",
                (r, n) ->
                    new ImportRow(
                        r.getString("uid"),
                        r.getString("team_id"),
                        r.getString("manifest"),
                        r.getString("task_id")),
                uuid(id),
                uid)
            .stream()
            .findFirst()
            .orElseThrow(TaskStorageService::missing);
    teams.requireMember(uid, row.team());
    return row;
  }

  private static boolean text(String s, int max) {
    return s != null && !s.isBlank() && s.length() <= max;
  }

  private StartImport validate(StartImport input) {
    if (input == null) throw ApiException.validation();
    uuid(input.registration_key());
    if (!text(input.title(), 1024)
        || input.kind() == null
        || input.mode_path() == null
        || !Set.of("files", "folder").contains(input.kind())
        || !Set.of("segmentation/dicomlocal", "microscopy").contains(input.mode_path())
        || input.files() == null
        || input.files().isEmpty()
        || input.files().size() > 10000
        || ("folder".equals(input.kind()) && !text(input.folder_name(), 1024)))
      throw ApiException.validation();
    Set<String> ids = new HashSet<>();
    Set<Integer> indexes = new HashSet<>();
    long total = 0;
    List<SourceFile> normalized = new ArrayList<>();
    for (var f : input.files()) {
      if (f == null) throw ApiException.validation();
      String fileId = uuid(f.file_id());
      if (!ids.add(fileId)
          || !indexes.add(f.selection_index())
          || f.selection_index() < 0
          || !text(f.file_name(), 1024)
          || f.size() <= 0
          || f.size() > maxFile
          || !uidValue(f.study_uid())
          || !uidValue(f.series_uid())
          || !uidValue(f.sop_uid())
          || f.relative_path() != null && f.relative_path().length() > 4096)
        throw ApiException.validation();
      normalized.add(
          new SourceFile(
              fileId,
              f.selection_index(),
              f.file_name(),
              f.relative_path(),
              f.size(),
              f.study_uid(),
              f.series_uid(),
              f.sop_uid()));
      total += f.size();
      if (total > maxStudy)
        throw new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE", "导入批次超过运行期限额");
    }
    return new StartImport(
        uuid(input.registration_key()),
        input.title(),
        input.kind(),
        input.folder_name(),
        input.mode_path(),
        List.copyOf(normalized));
  }

  private static boolean uidValue(String x) {
    return x != null && x.length() <= 64 && x.matches("[0-9]+(\\.[0-9]+)+");
  }

  public ImportView start(String uid, String rawTeam, StartImport rawInput) {
    String team = uuid(rawTeam);
    teams.requireMember(uid, team);
    var input = validate(rawInput);
    synchronized (lock(uid + input.registration_key())) {
      var existing =
          jdbc.queryForList(
              "SELECT import_id,manifest,team_id FROM task_import WHERE uid=? AND"
                  + " registration_key=?",
              uid,
              input.registration_key());
      String body = encode(input), id;
      if (!existing.isEmpty()) {
        var row = existing.getFirst();
        id = (String) row.get("IMPORT_ID");
        String saved =
            jdbc.queryForObject(
                "SELECT manifest FROM task_import WHERE import_id=?", String.class, id);
        if (!body.equals(saved) || !team.equals(row.get("TEAM_ID")))
          throw conflict("IDEMPOTENCY_PAYLOAD_MISMATCH");
      } else {
        if (tasks.registration(uid, input.registration_key()).isPresent())
          throw conflict("REGISTRATION_KEY_USED");
        id = UUID.randomUUID().toString();
        jdbc.update(
            "INSERT INTO task_import(import_id,uid,team_id,registration_key,manifest)"
                + " VALUES(?,?,?,?,?)",
            id,
            uid,
            team,
            input.registration_key(),
            body);
      }
      String current = id;
      return new ImportView(
          id,
          input.files().stream()
              .filter(f -> blobs.containsKey("source/" + current + "/" + f.file_id()))
              .map(SourceFile::file_id)
              .toList());
    }
  }

  public void uploadSource(String uid, String rawId, String rawFile, InputStream stream)
      throws IOException {
    String id = uuid(rawId), file = uuid(rawFile);
    var row = importRow(uid, id);
    var spec =
        manifest(row.manifest()).files().stream()
            .filter(f -> f.file_id().equals(file))
            .findFirst()
            .orElseThrow(TaskStorageService::missing);
    synchronized (lock(id)) {
      if (row.taskId() != null) throw conflict("IMPORT_COMPLETED");
      store("source/" + id + "/" + file, uid, stream, spec.size());
    }
  }

  private void store(String key, String actor, InputStream stream, long expected)
      throws IOException {
    if (key.startsWith("result/")) {
      String prefix = key.substring(0, key.lastIndexOf('/') + 1);
      var staged = blobs.entrySet().stream().filter(e -> e.getKey().startsWith(prefix)).toList();
      if (!blobs.containsKey(key)
          && (staged.size() >= 32
              || staged.stream().mapToLong(e -> e.getValue().size()).sum()
                      + Math.max(expected, maxFile)
                  > maxStudy))
        throw new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE", "当前任务成果暂存超过限额");
    }
    Path temp = Files.createTempFile(root, "upload-", ".part");
    long size = 0;
    long reserved = 0;
    boolean retained = false;
    MessageDigest digest;
    try {
      digest = MessageDigest.getInstance("SHA-256");
    } catch (NoSuchAlgorithmException error) {
      throw new IllegalStateException(error);
    }
    try {
      try (var out = Files.newOutputStream(temp)) {
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = stream.read(buffer)) != -1) {
          size += read;
          reserved += read;
          if (occupied.addAndGet(read) > maxRuntime)
            throw new ApiException(
                HttpStatus.PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE", "本次后端运行的文件容量已满");
          if (size > maxFile || expected >= 0 && size > expected)
            throw new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE", "文件大小超过约束");
          digest.update(buffer, 0, read);
          out.write(buffer, 0, read);
        }
      }
      if (size == 0 || expected >= 0 && size != expected) throw ApiException.validation();
      String hash = HexFormat.of().formatHex(digest.digest());
      var previous = blobs.get(key);
      if (previous != null) {
        if (!hash.equals(previous.hash())) throw conflict("FILE_IMMUTABLE");
        return;
      }
      Path target = root.resolve(UUID.randomUUID().toString());
      Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE);
      blobs.put(key, new Blob(target, size, hash, actor));
      retained = true;
    } finally {
      Files.deleteIfExists(temp);
      if (!retained) occupied.addAndGet(-reserved);
    }
  }

  @Transactional
  public Task complete(String uid, String rawId) {
    String id = uuid(rawId);
    // 数据库行锁与任务登记、材料关联在同一事务确认。
    jdbc.queryForList(
        "SELECT import_id FROM task_import WHERE import_id=? AND uid=? FOR UPDATE", uuid(id), uid);
    var row = importRow(uid, id);
    var input = manifest(row.manifest());
    if (row.taskId() != null) return task(row.taskId());
    for (var f : input.files())
      if (!blobs.containsKey("source/" + id + "/" + f.file_id()))
        throw conflict("IMPORT_INCOMPLETE");
    if (tasks.registration(uid, input.registration_key()).isPresent())
      throw conflict("REGISTRATION_KEY_USED");
    var now = clock.instant();
    var task =
        new Task(UUID.randomUUID().toString(), row.team(), input.title(), uid, Map.of(), now, now);
    tasks.insertTask(task);
    tasks.insertRegistration(
        uid, input.registration_key(), registrations.digest(row.team(), input.title()), task);
    jdbc.update(
        "INSERT INTO task_material(task_id,import_id,manifest) VALUES(?,?,?)",
        task.task_id(),
        id,
        row.manifest());
    jdbc.update("UPDATE task_import SET task_id=? WHERE import_id=?", task.task_id(), id);
    return task;
  }

  private Task task(String id) {
    return jdbc
        .query(
            "SELECT * FROM task_record WHERE task_id=?",
            (r, n) ->
                new Task(
                    r.getString("task_id"),
                    r.getString("team_id"),
                    r.getString("title"),
                    r.getString("assignee_uid"),
                    Map.of(),
                    r.getObject("created_at", java.time.OffsetDateTime.class).toInstant(),
                    r.getObject("updated_at", java.time.OffsetDateTime.class).toInstant()),
            uuid(id))
        .stream()
        .findFirst()
        .orElseThrow(TaskStorageService::missing);
  }

  public Access access(String uid, String rawId, boolean write) {
    String id = uuid(rawId);
    var task = task(id);
    teams.requireMember(uid, task.team_id());
    boolean editable =
        jdbc.queryForObject(
                "SELECT COUNT(*) FROM task_read_only WHERE task_id=? AND uid=?",
                Integer.class,
                id,
                uid)
            == 0;
    if (write && !editable) throw new ApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "当前任务为只读");
    return new Access(task.assignee_uid(), editable);
  }

  public Materials materials(String uid, String rawId) {
    String id = uuid(rawId);
    var access = access(uid, id, false);
    String body =
        jdbc
            .query(
                "SELECT manifest FROM task_material WHERE task_id=?", (r, n) -> r.getString(1), id)
            .stream()
            .findFirst()
            .orElseThrow(TaskStorageService::missing);
    return new Materials(task(id), manifest(body), access);
  }

  public Path source(String uid, String rawId, String rawFile) {
    String id = uuid(rawId), file = uuid(rawFile);
    var material = materials(uid, id);
    if (material.source().files().stream().noneMatch(f -> f.file_id().equals(file)))
      throw missing();
    String importId =
        jdbc.queryForObject(
            "SELECT import_id FROM task_material WHERE task_id=?", String.class, id);
    return blob("source/" + importId + "/" + file).path();
  }

  private Blob blob(String key) {
    var b = blobs.get(key);
    if (b == null) throw missing();
    return b;
  }

  public Results results(String uid, String rawId) {
    String id = uuid(rawId);
    var access = access(uid, id, false);
    return jdbc
        .query(
            "SELECT revision,results FROM task_material WHERE task_id=?",
            (r, n) -> new Results(r.getLong(1), objects(r.getString(2)), access),
            id)
        .stream()
        .findFirst()
        .orElseThrow(TaskStorageService::missing);
  }

  public void uploadResult(String uid, String rawId, String rawObject, InputStream stream)
      throws IOException {
    String id = uuid(rawId), object = uuid(rawObject);
    access(uid, id, true);
    results(uid, id);
    synchronized (lock(id)) {
      store("result/" + id + "/" + object, uid, stream, -1);
    }
  }

  public Path resultFile(String uid, String rawId, String rawObject) {
    String id = uuid(rawId), object = uuid(rawObject);
    if (results(uid, id).objects().stream().noneMatch(o -> o.object_id().equals(object)))
      throw missing();
    return blob("result/" + id + "/" + object).path();
  }

  private void validateArtifact(Blob blob, String taskId, String type) {
    try (var input = Files.newInputStream(blob.path())) {
      byte[] prefix = input.readNBytes(4);
      if (prefix.length != 4) throw ApiException.validation();
      int length =
          java.nio.ByteBuffer.wrap(prefix).order(java.nio.ByteOrder.LITTLE_ENDIAN).getInt();
      if (length <= 0 || length > 16 * 1024 * 1024 || 4L + length > blob.size())
        throw ApiException.validation();
      byte[] header = input.readNBytes(length);
      if (header.length != length) throw ApiException.validation();
      var value = json.readTree(header);
      if (value == null || !value.isObject()) throw ApiException.validation();
      var state = value.path("state");
      if (value.path("version").asInt() != 1
          || !taskId.equals(value.path("task_id").asText())
          || !type.equals(value.path("type").asText())
          || !taskId.equals(state.path("taskId").asText())
          || !state.path("annotations").isArray()
          || !state.path("measurements").isArray()
          || !state.path("segmentations").isArray()) throw ApiException.validation();
      if (4L + length + binaryLength(state) != blob.size()) throw ApiException.validation();
    } catch (IOException invalid) {
      throw ApiException.validation();
    }
  }

  private long binaryLength(com.fasterxml.jackson.databind.JsonNode value) {
    if (value.isObject() && value.has("$array")) {
      if (!Set.of(
                  "Uint8Array",
                  "Uint8ClampedArray",
                  "Uint16Array",
                  "Uint32Array",
                  "Int8Array",
                  "Int16Array",
                  "Int32Array",
                  "Float32Array",
                  "Float64Array")
              .contains(value.path("$array").asText())
          || !value.path("bytes").isIntegralNumber()
          || value.path("bytes").asLong() < 0
          || value.path("bytes").asLong() > maxFile) throw ApiException.validation();
      return value.path("bytes").asLong();
    }
    long bytes = 0;
    if (value.isContainerNode())
      for (var child : value) {
        bytes += binaryLength(child);
        if (bytes > maxFile) throw ApiException.validation();
      }
    return bytes;
  }

  @Transactional
  public Results commit(String uid, String rawId, Commit rawInput) {
    String id = uuid(rawId);
    var access = access(uid, id, true);
    if (rawInput == null
        || rawInput.base_revision() < 0
        || rawInput.objects() == null
        || rawInput.objects().size() > 10000) throw ApiException.validation();
    List<ResultObject> normalized = new ArrayList<>();
    for (var object : rawInput.objects()) {
      if (object == null) throw ApiException.validation();
      normalized.add(new ResultObject(uuid(object.object_id()), object.type()));
    }
    var input =
        new Commit(
            rawInput.base_revision(), uuid(rawInput.operation_id()), List.copyOf(normalized));
    jdbc.queryForList("SELECT task_id FROM task_material WHERE task_id=? FOR UPDATE", uuid(id));
    access = access(uid, id, true);
    var current = results(uid, id);
    String payload = encode(input);
    var replay =
        jdbc.queryForList(
            "SELECT actor_uid,payload,response FROM task_result_operation WHERE task_id=? AND"
                + " operation_id=?",
            id,
            input.operation_id());
    if (!replay.isEmpty()) {
      var row = replay.getFirst();
      String saved =
          jdbc.queryForObject(
              "SELECT payload FROM task_result_operation WHERE task_id=? AND operation_id=?",
              String.class,
              id,
              input.operation_id());
      if (!uid.equals(row.get("ACTOR_UID")) || !payload.equals(saved))
        throw conflict("IDEMPOTENCY_PAYLOAD_MISMATCH");
      String response =
          jdbc.queryForObject(
              "SELECT response FROM task_result_operation WHERE task_id=? AND operation_id=?",
              String.class,
              id,
              input.operation_id());
      var old = decode(response, Results.class);
      return new Results(old.revision(), old.objects(), access);
    }
    if (current.revision() != input.base_revision()) throw conflict("REVISION_CONFLICT");
    Set<String> seen = new HashSet<>(), existing = new HashSet<>();
    current.objects().forEach(o -> existing.add(o.object_id()));
    for (var o : input.objects()) {
      if (o == null) throw ApiException.validation();
      uuid(o.object_id());
      if (o.type() == null
          || !seen.add(o.object_id())
          || !Set.of("SR", "SEG", "RTSTRUCT").contains(o.type())) throw ApiException.validation();
      var value = blob("result/" + id + "/" + o.object_id());
      validateArtifact(value, id, o.type());
      if (!existing.contains(o.object_id()) && !uid.equals(value.actor())) throw missing();
    }
    var next = new Results(current.revision() + 1, List.copyOf(input.objects()), access);
    jdbc.update(
        "UPDATE task_material SET revision=?,results=? WHERE task_id=?",
        next.revision(),
        encode(next.objects()),
        id);
    jdbc.update(
        "INSERT INTO task_result_operation(task_id,operation_id,actor_uid,payload,response)"
            + " VALUES(?,?,?,?,?)",
        id,
        input.operation_id(),
        uid,
        payload,
        encode(next));
    var keep = Set.copyOf(seen);
    org.springframework.transaction.support.TransactionSynchronizationManager
        .registerSynchronization(
            new org.springframework.transaction.support.TransactionSynchronization() {
              @Override
              public void afterCommit() {
                for (var old : current.objects())
                  if (!keep.contains(old.object_id())) {
                    var removed = blobs.remove("result/" + id + "/" + old.object_id());
                    if (removed != null)
                      try {
                        Files.deleteIfExists(removed.path());
                        occupied.addAndGet(-removed.size());
                      } catch (IOException ignored) {
                        /* 实例退出时再次清理。 */
                      }
                  }
              }
            });
    jdbc.update(
        "UPDATE task_record SET updated_at=GREATEST(updated_at,?) WHERE task_id=?",
        IdentityRepository.utc(clock.instant()),
        id);
    return next;
  }

  @PreDestroy
  public void close() throws IOException {
    try (var paths = Files.walk(root)) {
      for (var p : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(p);
    }
    blobs.clear();
    locks.clear();
  }
}
