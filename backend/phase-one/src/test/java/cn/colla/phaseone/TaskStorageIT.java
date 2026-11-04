package cn.colla.phaseone;

import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.*;
import org.junit.jupiter.api.Test;

@org.springframework.boot.test.context.SpringBootTest(
    properties = "colla.database-name=task_storage_it")
class TaskStorageIT extends InvitationTestSupport {
  @org.junit.jupiter.api.AfterEach
  void clearTasks() {
    for (String table : List.of("task_visit", "task_registration", "task_record"))
      jdbc.update("DELETE FROM " + table);
  }

  byte[] artifact(String id, String type) throws Exception {
    byte[] header =
        json.writeValueAsBytes(
            Map.of(
                "version",
                1,
                "task_id",
                id,
                "type",
                type,
                "state",
                Map.of(
                    "taskId",
                    id,
                    "annotations",
                    List.of(),
                    "measurements",
                    List.of(),
                    "segmentations",
                    List.of())));
    return java.nio.ByteBuffer.allocate(4 + header.length)
        .order(java.nio.ByteOrder.LITTLE_ENDIAN)
        .putInt(header.length)
        .put(header)
        .array();
  }

  @Test
  void unreadIsIndependentAndSelectionSurvivesLogin() throws Exception {
    var a = register("notice-a");
    var b = register("notice-b");
    var c = register("notice-c");
    var invitation = invite(a, b);
    String id = invitation.path("invitation_id").asText();
    http.perform(
            get("/api/v1/notifications/team-invitations/unread-count")
                .header("Authorization", token(b)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.data.unread_count").value(1));
    http.perform(
            post("/api/v1/notifications/team-invitations/read")
                .header("Authorization", token(c))
                .contentType("application/json")
                .content(json.writeValueAsString(Map.of("invitation_ids", List.of(id)))))
        .andExpect(status().isNotFound());
    http.perform(
            post("/api/v1/notifications/team-invitations/read")
                .header("Authorization", token(b))
                .contentType("application/json")
                .content(json.writeValueAsString(Map.of("invitation_ids", List.of(id)))))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.data.unread_count").value(0));
    assertThat(
            jdbc.queryForObject(
                "SELECT decision FROM team_invitation WHERE invitation_id=?", String.class, id))
        .isEqualTo("pending");
    decide(b, id, "accept").andExpect(status().isOk());
    http.perform(
            put("/api/v1/auth/sessions/current/team")
                .header("Authorization", token(b))
                .contentType("application/json")
                .content(json.writeValueAsString(Map.of("team_id", team(a)))))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.data.selected_team_id").value(team(a)))
        .andExpect(jsonPath("$.data.default_team_id").value(team(b)));
    http.perform(
            post("/api/v1/auth/sessions")
                .contentType("application/json")
                .content("{\"username\":\"notice-b\",\"password\":\"test-password\"}"))
        .andExpect(status().isCreated())
        .andExpect(jsonPath("$.data.selected_team_id").value(team(a)));
  }

  JsonNode start(JsonNode user, String key, String file) throws Exception {
    return data(
        http.perform(
                post("/api/v1/teams/" + team(user) + "/task-imports")
                    .header("Authorization", token(user))
                    .contentType("application/json")
                    .content(
                        json.writeValueAsString(
                            Map.of(
                                "registration_key",
                                key,
                                "title",
                                "slice.dcm",
                                "kind",
                                "files",
                                "mode_path",
                                "segmentation/dicomlocal",
                                "files",
                                List.of(
                                    Map.of(
                                        "file_id",
                                        file,
                                        "selection_index",
                                        0,
                                        "file_name",
                                        "slice.dcm",
                                        "size",
                                        4,
                                        "study_uid",
                                        "1.2.3",
                                        "series_uid",
                                        "1.2.3.4",
                                        "sop_uid",
                                        "1.2.3.4.5"))))))
            .andExpect(status().isOk()));
  }

  @Test
  void stagedFilesReopenForMemberAndResultsAreAtomicAndProtected() throws Exception {
    var a = register("storage-a");
    var b = register("storage-b");
    var c = register("storage-c");
    var invitation = invite(a, b);
    decide(b, invitation.path("invitation_id").asText(), "accept");
    String key = UUID.randomUUID().toString(), file = UUID.randomUUID().toString();
    String id = start(a, key, file).path("import_id").asText();
    assertThat(start(a, key, file).path("import_id").asText()).isEqualTo(id);
    http.perform(post("/api/v1/task-imports/" + id + "/complete").header("Authorization", token(a)))
        .andExpect(status().isConflict());
    http.perform(
            put("/api/v1/task-imports/" + id + "/files/" + file)
                .header("Authorization", token(c))
                .content(new byte[] {1, 2, 3, 4}))
        .andExpect(status().isNotFound());
    http.perform(
            put("/api/v1/task-imports/" + id + "/files/" + file)
                .header("Authorization", token(a))
                .content(new byte[] {1, 2, 3, 4}))
        .andExpect(status().isOk());
    var task =
        data(
            http.perform(
                    post("/api/v1/task-imports/" + id + "/complete")
                        .header("Authorization", token(a)))
                .andExpect(status().isOk()));
    String tid = task.path("task_id").asText();
    http.perform(get("/api/v1/tasks/" + tid + "/materials").header("Authorization", token(b)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.data.access.can_edit").value(true));
    http.perform(get("/api/v1/tasks/" + tid + "/files/" + file).header("Authorization", token(b)))
        .andExpect(status().isOk())
        .andExpect(content().bytes(new byte[] {1, 2, 3, 4}));
    http.perform(get("/api/v1/tasks/" + tid + "/materials").header("Authorization", token(c)))
        .andExpect(status().isNotFound());
    String object = UUID.randomUUID().toString();
    http.perform(
            put("/api/v1/tasks/" + tid + "/result-files/" + object)
                .header("Authorization", token(b))
                .content(artifact(tid, "SEG")))
        .andExpect(status().isOk());
    http.perform(
            get("/api/v1/tasks/" + tid + "/result-files/" + object)
                .header("Authorization", token(b)))
        .andExpect(status().isNotFound());
    String op = UUID.randomUUID().toString();
    String payload =
        json.writeValueAsString(
            Map.of(
                "base_revision",
                0,
                "operation_id",
                op,
                "objects",
                List.of(Map.of("object_id", object, "type", "SEG"))));
    http.perform(
            post("/api/v1/tasks/" + tid + "/results/commit")
                .header("Authorization", token(b))
                .contentType("application/json")
                .content(payload))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.data.revision").value(1));
    http.perform(
            post("/api/v1/tasks/" + tid + "/results/commit")
                .header("Authorization", token(b))
                .contentType("application/json")
                .content(payload))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.data.revision").value(1));
    http.perform(
            post("/api/v1/tasks/" + tid + "/results/commit")
                .header("Authorization", token(b))
                .contentType("application/json")
                .content(
                    json.writeValueAsString(
                        Map.of(
                            "base_revision",
                            0,
                            "operation_id",
                            UUID.randomUUID().toString(),
                            "objects",
                            List.of()))))
        .andExpect(status().isConflict());
    http.perform(
            get("/api/v1/tasks/" + tid + "/result-files/" + object)
                .header("Authorization", token(b)))
        .andExpect(status().isOk())
        .andExpect(content().bytes(artifact(tid, "SEG")));
    jdbc.update("INSERT INTO task_read_only(task_id,uid) VALUES(?,?)", tid, uid(b));
    http.perform(
            put("/api/v1/tasks/" + tid + "/result-files/" + UUID.randomUUID())
                .header("Authorization", token(b))
                .content(new byte[] {0}))
        .andExpect(status().isForbidden());
    http.perform(get("/api/v1/tasks/" + tid + "/results").header("Authorization", token(b)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.data.access.can_edit").value(false));
    http.perform(
            post("/api/v1/tasks/" + tid + "/results/commit")
                .header("Authorization", token(a))
                .contentType("application/json")
                .content(
                    json.writeValueAsString(
                        Map.of(
                            "base_revision",
                            1,
                            "operation_id",
                            UUID.randomUUID().toString(),
                            "objects",
                            List.of()))))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.data.objects.length()").value(0));
  }

  @Test
  void invalidImportManifestsAreRejectedWithoutCreatingTasks() throws Exception {
    var user = register("validation");
    var valid = json.createObjectNode();
    valid.put("registration_key", UUID.randomUUID().toString());
    valid.put("title", "test.dcm");
    valid.put("kind", "files");
    valid.put("mode_path", "segmentation/dicomlocal");
    var file = json.createObjectNode();
    file.put("file_id", UUID.randomUUID().toString());
    file.put("selection_index", 0);
    file.put("file_name", "test.dcm");
    file.put("size", 4);
    file.put("study_uid", "1.2");
    file.put("series_uid", "1.2.3");
    file.put("sop_uid", "1.2.3.4");
    valid.putArray("files").add(file);
    var variants = new ArrayList<com.fasterxml.jackson.databind.node.ObjectNode>();
    for (String field : List.of("registration_key", "title", "kind", "mode_path", "files")) {
      var v = valid.deepCopy();
      v.putNull(field);
      variants.add(v);
    }
    for (String field : List.of("title", "kind", "mode_path")) {
      var v = valid.deepCopy();
      v.put(field, "");
      variants.add(v);
    }
    var largeTitle = valid.deepCopy();
    largeTitle.put("title", "x".repeat(1025));
    variants.add(largeTitle);
    var folder = valid.deepCopy();
    folder.put("kind", "folder");
    variants.add(folder);
    var empty = valid.deepCopy();
    empty.putArray("files");
    variants.add(empty);
    for (String field : List.of("file_id", "file_name", "study_uid", "series_uid", "sop_uid")) {
      var v = valid.deepCopy();
      ((com.fasterxml.jackson.databind.node.ObjectNode) v.path("files").get(0)).putNull(field);
      variants.add(v);
    }
    for (String field : List.of("study_uid", "series_uid", "sop_uid")) {
      var v = valid.deepCopy();
      ((com.fasterxml.jackson.databind.node.ObjectNode) v.path("files").get(0))
          .put(field, "invalid-uid");
      variants.add(v);
    }
    for (long size : List.of(0L, -1L, 536870913L)) {
      var v = valid.deepCopy();
      ((com.fasterxml.jackson.databind.node.ObjectNode) v.path("files").get(0)).put("size", size);
      variants.add(v);
    }
    var negative = valid.deepCopy();
    ((com.fasterxml.jackson.databind.node.ObjectNode) negative.path("files").get(0))
        .put("selection_index", -1);
    variants.add(negative);
    var longName = valid.deepCopy();
    ((com.fasterxml.jackson.databind.node.ObjectNode) longName.path("files").get(0))
        .put("file_name", "x".repeat(1025));
    variants.add(longName);
    var longPath = valid.deepCopy();
    ((com.fasterxml.jackson.databind.node.ObjectNode) longPath.path("files").get(0))
        .put("relative_path", "x".repeat(4097));
    variants.add(longPath);
    var duplicated = valid.deepCopy();
    ((com.fasterxml.jackson.databind.node.ArrayNode) duplicated.path("files")).add(file.deepCopy());
    variants.add(duplicated);
    var nullFile = valid.deepCopy();
    nullFile.putArray("files").addNull();
    variants.add(nullFile);
    for (var value : variants)
      http.perform(
              post("/api/v1/teams/" + team(user) + "/task-imports")
                  .header("Authorization", token(user))
                  .contentType("application/json")
                  .content(json.writeValueAsString(value)))
          .andExpect(status().isUnprocessableEntity());
    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM task_record", Integer.class)).isZero();
  }

  @Test
  void stagedUploadsAreImmutableAndCompletionIsIdempotent() throws Exception {
    var a = register("immutable");
    String key = UUID.randomUUID().toString(), file = UUID.randomUUID().toString();
    String id = start(a, key, file).path("import_id").asText();
    String upload = "/api/v1/task-imports/" + id + "/files/" + file;
    http.perform(put(upload).header("Authorization", token(a)).content(new byte[] {1, 2, 3}))
        .andExpect(status().isUnprocessableEntity());
    http.perform(put(upload).header("Authorization", token(a)).content(new byte[] {1, 2, 3, 4, 5}))
        .andExpect(status().isPayloadTooLarge());
    http.perform(put(upload).header("Authorization", token(a)).content(new byte[] {1, 2, 3, 4}))
        .andExpect(status().isOk());
    http.perform(put(upload).header("Authorization", token(a)).content(new byte[] {1, 2, 3, 4}))
        .andExpect(status().isOk());
    http.perform(put(upload).header("Authorization", token(a)).content(new byte[] {4, 3, 2, 1}))
        .andExpect(status().isConflict());
    var task =
        data(
            http.perform(
                    post("/api/v1/task-imports/" + id + "/complete")
                        .header("Authorization", token(a)))
                .andExpect(status().isOk()));
    http.perform(post("/api/v1/task-imports/" + id + "/complete").header("Authorization", token(a)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.data.task_id").value(task.path("task_id").asText()));
    http.perform(put(upload).header("Authorization", token(a)).content(new byte[] {1, 2, 3, 4}))
        .andExpect(status().isConflict());
    http.perform(
            get("/api/v1/tasks/" + task.path("task_id").asText() + "/files/" + UUID.randomUUID())
                .header("Authorization", token(a)))
        .andExpect(status().isNotFound());
    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM task_record", Integer.class)).isEqualTo(1);
  }

  @Test
  void uuidCaseDoesNotChangeStorageIdentityOrBypassReadOnly() throws Exception {
    var a = register("canonical-ids");
    String key = UUID.randomUUID().toString(), file = UUID.randomUUID().toString();
    String id = start(a, key, file).path("import_id").asText();
    assertThat(
            start(a, key.toUpperCase(Locale.ROOT), file.toUpperCase(Locale.ROOT))
                .path("import_id")
                .asText())
        .isEqualTo(id);
    String upperImport = id.toUpperCase(Locale.ROOT), upperFile = file.toUpperCase(Locale.ROOT);
    http.perform(
            put("/api/v1/task-imports/" + upperImport + "/files/" + upperFile)
                .header("Authorization", token(a))
                .content(new byte[] {1, 2, 3, 4}))
        .andExpect(status().isOk());
    String task =
        data(http.perform(
                    post("/api/v1/task-imports/" + upperImport + "/complete")
                        .header("Authorization", token(a)))
                .andExpect(status().isOk()))
            .path("task_id")
            .asText();
    String upperTask = task.toUpperCase(Locale.ROOT);
    http.perform(post("/api/v1/task-imports/" + id + "/complete").header("Authorization", token(a)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.data.task_id").value(task));
    http.perform(get("/api/v1/tasks/" + upperTask + "/materials").header("Authorization", token(a)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.data.source.files[0].file_id").value(file));
    http.perform(
            get("/api/v1/tasks/" + upperTask + "/files/" + upperFile)
                .header("Authorization", token(a)))
        .andExpect(status().isOk())
        .andExpect(content().bytes(new byte[] {1, 2, 3, 4}));
    String object = UUID.randomUUID().toString(), operation = UUID.randomUUID().toString();
    byte[] packet = artifact(task, "SR");
    http.perform(
            put("/api/v1/tasks/" + upperTask + "/result-files/" + object.toUpperCase(Locale.ROOT))
                .header("Authorization", token(a))
                .content(packet))
        .andExpect(status().isOk());
    String upperBody =
        json.writeValueAsString(
            Map.of(
                "base_revision",
                0,
                "operation_id",
                operation.toUpperCase(Locale.ROOT),
                "objects",
                List.of(Map.of("object_id", object.toUpperCase(Locale.ROOT), "type", "SR"))));
    String lowerBody =
        json.writeValueAsString(
            Map.of(
                "base_revision",
                0,
                "operation_id",
                operation,
                "objects",
                List.of(Map.of("object_id", object, "type", "SR"))));
    http.perform(
            post("/api/v1/tasks/" + upperTask + "/results/commit")
                .header("Authorization", token(a))
                .contentType("application/json")
                .content(upperBody))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.data.revision").value(1));
    http.perform(
            post("/api/v1/tasks/" + task + "/results/commit")
                .header("Authorization", token(a))
                .contentType("application/json")
                .content(lowerBody))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.data.revision").value(1));
    http.perform(
            get("/api/v1/tasks/" + upperTask + "/result-files/" + object.toUpperCase(Locale.ROOT))
                .header("Authorization", token(a)))
        .andExpect(status().isOk())
        .andExpect(content().bytes(packet));
    jdbc.update("INSERT INTO task_read_only(task_id,uid) VALUES(?,?)", task, uid(a));
    http.perform(get("/api/v1/tasks/" + upperTask + "/results").header("Authorization", token(a)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.data.access.can_edit").value(false));
    http.perform(
            put("/api/v1/tasks/" + upperTask + "/result-files/" + UUID.randomUUID())
                .header("Authorization", token(a))
                .content(packet))
        .andExpect(status().isForbidden());
    http.perform(
            post("/api/v1/tasks/" + upperTask + "/results/commit")
                .header("Authorization", token(a))
                .contentType("application/json")
                .content(upperBody))
        .andExpect(status().isForbidden());
  }

  @Test
  void invalidResultPacketsCannotBecomeConfirmedResults() throws Exception {
    var a = register("packet-validation");
    String file = UUID.randomUUID().toString();
    String id = start(a, UUID.randomUUID().toString(), file).path("import_id").asText();
    http.perform(
            put("/api/v1/task-imports/" + id + "/files/" + file)
                .header("Authorization", token(a))
                .content(new byte[] {1, 2, 3, 4}))
        .andExpect(status().isOk());
    String task =
        data(http.perform(
                    post("/api/v1/task-imports/" + id + "/complete")
                        .header("Authorization", token(a)))
                .andExpect(status().isOk()))
            .path("task_id")
            .asText();
    var bad = new ArrayList<byte[]>();
    bad.add(new byte[] {1});
    bad.add(new byte[] {-1, -1, -1, -1});
    bad.add(new byte[] {100, 0, 0, 0});
    for (String header : List.of("null", "[]", "1", "\"text\"", "{}")) {
      byte[] bytes = header.getBytes(java.nio.charset.StandardCharsets.UTF_8);
      bad.add(
          java.nio.ByteBuffer.allocate(4 + bytes.length)
              .order(java.nio.ByteOrder.LITTLE_ENDIAN)
              .putInt(bytes.length)
              .put(bytes)
              .array());
    }
    for (String field : List.of("version", "task_id", "type")) {
      var root =
          json.readTree(
              java.util.Arrays.copyOfRange(artifact(task, "SEG"), 4, artifact(task, "SEG").length));
      ((com.fasterxml.jackson.databind.node.ObjectNode) root).put(field, "invalid");
      byte[] header = json.writeValueAsBytes(root);
      bad.add(
          java.nio.ByteBuffer.allocate(4 + header.length)
              .order(java.nio.ByteOrder.LITTLE_ENDIAN)
              .putInt(header.length)
              .put(header)
              .array());
    }
    for (String field : List.of("taskId", "annotations", "measurements", "segmentations")) {
      var root =
          json.readTree(
              java.util.Arrays.copyOfRange(artifact(task, "SEG"), 4, artifact(task, "SEG").length));
      ((com.fasterxml.jackson.databind.node.ObjectNode) root.path("state")).putNull(field);
      byte[] header = json.writeValueAsBytes(root);
      bad.add(
          java.nio.ByteBuffer.allocate(4 + header.length)
              .order(java.nio.ByteOrder.LITTLE_ENDIAN)
              .putInt(header.length)
              .put(header)
              .array());
    }
    for (byte[] bytes : bad) {
      String object = UUID.randomUUID().toString();
      http.perform(
              put("/api/v1/tasks/" + task + "/result-files/" + object)
                  .header("Authorization", token(a))
                  .content(bytes))
          .andExpect(status().isOk());
      http.perform(
              post("/api/v1/tasks/" + task + "/results/commit")
                  .header("Authorization", token(a))
                  .contentType("application/json")
                  .content(
                      json.writeValueAsString(
                          Map.of(
                              "base_revision",
                              0,
                              "operation_id",
                              UUID.randomUUID().toString(),
                              "objects",
                              List.of(Map.of("object_id", object, "type", "SEG"))))))
          .andExpect(status().isUnprocessableEntity());
    }
    http.perform(get("/api/v1/tasks/" + task + "/results").header("Authorization", token(a)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.data.revision").value(0));
    http.perform(
            get("/api/v1/tasks/" + task + "/result-files/" + UUID.randomUUID())
                .header("Authorization", token(a)))
        .andExpect(status().isNotFound());
  }

  @Test
  void invalidReadBatchesDoNotClearUnreadInvitations() throws Exception {
    var a = register("read-validation-a");
    var b = register("read-validation-b");
    invite(a, b);
    for (Object ids :
        List.of(
            List.of("invalid"), java.util.Collections.nCopies(1001, UUID.randomUUID().toString())))
      http.perform(
              post("/api/v1/notifications/team-invitations/read")
                  .header("Authorization", token(b))
                  .contentType("application/json")
                  .content(json.writeValueAsString(Map.of("invitation_ids", ids))))
          .andExpect(status().isUnprocessableEntity());
    http.perform(
            post("/api/v1/notifications/team-invitations/read")
                .header("Authorization", token(b))
                .contentType("application/json")
                .content("{\"invitation_ids\":null}"))
        .andExpect(status().isUnprocessableEntity());
    http.perform(
            post("/api/v1/notifications/team-invitations/read")
                .header("Authorization", token(b))
                .contentType("application/json")
                .content("{\"invitation_ids\":[]}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.data.unread_count").value(1));
  }
}
