package cn.colla.phaseone;

import cn.colla.phaseone.auth.SessionService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.*;
import java.util.concurrent.*;
import org.h2.api.Trigger;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = "colla.database-name=task_registration_c_it")
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
class TaskRegistrationIT {
    @Autowired MockMvc http;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired SessionService sessions;
    @Autowired org.springframework.transaction.PlatformTransactionManager manager;
    String uid, team, token, otherUid, otherTeam, otherToken;
    @BeforeEach void clean() {
        jdbc.execute("DROP TRIGGER IF EXISTS registration_fault");
        jdbc.execute("DROP INDEX IF EXISTS unique_test_title");
        var tables = jdbc.queryForList("SELECT LOWER(TABLE_NAME) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='PUBLIC'", String.class);
        for (String table : List.of("task_registration", "task_record", "auth_session", "team_member", "team", "app_user"))
            if (tables.contains(table)) jdbc.update("DELETE FROM " + table);
        uid = UUID.randomUUID().toString(); team = fixture(uid);
        otherUid = UUID.randomUUID().toString(); otherTeam = fixture(otherUid);
        token = sessions.issue(uid).token(); otherToken = sessions.issue(otherUid).token();
    }
    String fixture(String user) {
        var now = OffsetDateTime.ofInstant(Instant.now(), ZoneOffset.UTC);
        String owned = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO app_user(uid,username,password_hash,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)", user, user, "unused-synthetic-fixture", now, now);
        jdbc.update("INSERT INTO team(team_id,name,owner_uid,created_at,updated_at) VALUES(?,?,?,?,?)", owned, "合成团队", user, now, now);
        jdbc.update("INSERT INTO team_member(team_id,uid,role,joined_at) VALUES(?,?,'owner',?)", owned, user, now);
        return owned;
    }
    MockHttpServletRequestBuilder request(String targetTeam, String bearer, String key, String payload) {
        var request = post("/api/v1/teams/" + targetTeam + "/tasks").header("Authorization", "Bearer " + bearer).contentType("application/json").content(payload);
        return key == null ? request : request.header("Idempotency-Key", key);
    }
    JsonNode create(String key, int status) throws Exception {
        return json.readTree(http.perform(request(team, token, key, "{\"title\":\"合成影像.dcm\"}"))
            .andExpect(status().is(status)).andReturn().getResponse().getContentAsString()).path("data");
    }
    int count(String table) { return jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Integer.class); }

    @Test void principalCreatesSevenFieldsWithRealIdEmptyMetadataAndSqlEvidence() throws Exception {
        var data = create(UUID.randomUUID().toString(), 201);
        assertThat(data.properties().stream().map(Map.Entry::getKey).toList()).containsExactlyInAnyOrder("task_id", "team_id", "title", "assignee_uid", "metadata", "created_at", "updated_at");
        assertThat(UUID.fromString(data.path("task_id").asText())).isNotNull();
        assertThat(data.path("assignee_uid").asText()).isEqualTo(uid);
        assertThat(data.path("team_id").asText()).isEqualTo(team);
        assertThat(data.path("metadata").isObject()).isTrue(); assertThat(data.path("metadata").size()).isZero();
        assertThat(data.path("created_at")).isEqualTo(data.path("updated_at"));
        assertThat(count("task_record")).isEqualTo(1); assertThat(count("task_registration")).isEqualTo(1);
        assertThat(json.readTree(jdbc.queryForObject("SELECT metadata FROM task_record", byte[].class)).isObject()).isTrue();
        var columns = jdbc.queryForList("SELECT LOWER(COLUMN_NAME) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='TASK_RECORD'", String.class);
        assertThat(columns).doesNotContain("status", "dicom_dataset_ids");
    }
    @ParameterizedTest @ValueSource(strings = {"{}", "{\"title\":null}", "{\"title\":123}", "{\"title\":\" \"}", "{\"title\":\"x\",\"metadata\":null}", "{\"title\":\"x\",\"metadata\":[]}", "{\"title\":\"x\",\"metadata\":{\"path\":\"private\"}}", "{\"title\":\"x\",\"assignee_uid\":\"forged\"}", "{\"title\":\"x\",\"task_id\":\"forged\"}", "{\"title\":\"x\",\"status\":\"draft\"}", "{\"title\":\"x\",\"dicom_dataset_ids\":[]}", "{\"title\":\"x\",\"unknown\":true}"})
    void rejectsUnknownForgedOrInvalidFields(String body) throws Exception {
        http.perform(request(team, token, UUID.randomUUID().toString(), body)).andExpect(status().isUnprocessableEntity());
    }
    @Test void exactTitleAndLengthBoundariesAreNotTrimmed() throws Exception {
        String title = " 名称\"\\\n" + "字".repeat(1018);
        assertThat(title.length()).isEqualTo(1024);
        http.perform(request(team, token, UUID.randomUUID().toString(), json.writeValueAsString(Map.of("title", title, "metadata", Map.of())))).andExpect(status().isCreated()).andExpect(jsonPath("$.data.title").value(title));
        http.perform(request(team, token, UUID.randomUUID().toString(), json.writeValueAsString(Map.of("title", "x".repeat(1025))))).andExpect(status().isUnprocessableEntity());
    }
    @ParameterizedTest @ValueSource(strings = {"", "bad-key", "1-1-1-1-1", "00000000-0000-0000-0000-000000000000junk"})
    void keyMustBeCanonicalUuid(String key) throws Exception {
        http.perform(request(team, token, key, "{\"title\":\"x\"}")).andExpect(status().isUnprocessableEntity());
    }
    @Test void missingKeyAndInvisibleTeamAreRejectedAndValidForeignMembershipWorks() throws Exception {
        http.perform(request(team, token, null, "{\"title\":\"x\"}")).andExpect(status().isUnprocessableEntity());
        http.perform(request(otherTeam, token, UUID.randomUUID().toString(), "{\"title\":\"x\"}")).andExpect(status().isNotFound());
        jdbc.update("INSERT INTO team_member(team_id,uid,role,joined_at) VALUES(?,?,'annotator',CURRENT_TIMESTAMP)", otherTeam, uid);
        http.perform(request(otherTeam, token, UUID.randomUUID().toString(), "{\"title\":\"x\"}")).andExpect(status().isCreated()).andExpect(jsonPath("$.data.team_id").value(otherTeam)).andExpect(jsonPath("$.data.assignee_uid").value(uid));
    }
    @Test void lostResponseReplaySameKeyHasSameIdAndCanonicalDigest() throws Exception {
        String key = UUID.randomUUID().toString(); var first = create(key, 201);
        assertThat(create(key, 200)).isEqualTo(first);
        var explicitEmpty = json.readTree(http.perform(request(team, token, key.toUpperCase(Locale.ROOT), "{\"metadata\":{},\"title\":\"合成影像.dcm\"}")).andExpect(status().isOk()).andReturn().getResponse().getContentAsString()).path("data");
        assertThat(explicitEmpty).isEqualTo(first);
        String canonical = json.writeValueAsString(List.of("task-registration-v1", team, "合成影像.dcm", Map.of()));
        String hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(canonical.getBytes(StandardCharsets.UTF_8)));
        assertThat(jdbc.queryForObject("SELECT payload_hash FROM task_registration", String.class)).isEqualTo(hash);
        assertThat(count("task_record")).isEqualTo(1);
    }
    @Test void changedPayloadOrTeamConflictsAndDifferentUsersDoNotShareKeys() throws Exception {
        String key = UUID.randomUUID().toString(); String id = create(key, 201).path("task_id").asText();
        http.perform(request(team, token, key, "{\"title\":\"changed\"}")).andExpect(status().isConflict()).andExpect(jsonPath("$.error.details.reason").value("IDEMPOTENCY_PAYLOAD_MISMATCH"));
        jdbc.update("INSERT INTO team_member(team_id,uid,role,joined_at) VALUES(?,?,'annotator',CURRENT_TIMESTAMP)", otherTeam, uid);
        http.perform(request(otherTeam, token, key, "{\"title\":\"合成影像.dcm\"}")).andExpect(status().isConflict());
        String other = json.readTree(http.perform(request(otherTeam, otherToken, key, "{\"title\":\"合成影像.dcm\"}")).andExpect(status().isCreated()).andReturn().getResponse().getContentAsString()).at("/data/task_id").asText();
        assertThat(other).isNotEqualTo(id); assertThat(count("task_record")).isEqualTo(2);
    }
    @Test void concurrentRequestsCommitOneTaskAndOneRegistrationWithSameRealId() throws Exception {
        String key = UUID.randomUUID().toString(); int n = 6; var barrier = new CyclicBarrier(n);
        try (var pool = Executors.newFixedThreadPool(n)) {
            var jobs = new ArrayList<Future<String>>();
            for (int i = 0; i < n; i++) jobs.add(pool.submit(() -> {
                barrier.await(10, TimeUnit.SECONDS);
                var response = http.perform(request(team, token, key, "{\"title\":\"concurrent\"}")).andReturn().getResponse();
                assertThat(response.getStatus()).isIn(200, 201);
                return json.readTree(response.getContentAsString()).at("/data/task_id").asText();
            }));
            var ids = new HashSet<String>(); for (var job : jobs) ids.add(job.get(15, TimeUnit.SECONDS));
            assertThat(ids).hasSize(1); assertThat(ids.iterator().next()).isNotEmpty();
        }
        assertThat(count("task_record")).isEqualTo(1); assertThat(count("task_registration")).isEqualTo(1);
    }
    @Test void replayRechecksMembershipAndActivePrincipal() throws Exception {
        String key = UUID.randomUUID().toString(); create(key, 201);
        jdbc.update("DELETE FROM team_member WHERE uid=?", uid);
        http.perform(request(team, token, key, "{\"title\":\"合成影像.dcm\"}")).andExpect(status().isNotFound());
        jdbc.update("UPDATE app_user SET status='disabled' WHERE uid=?", uid);
        http.perform(request(team, token, key, "{\"title\":\"合成影像.dcm\"}")).andExpect(status().isUnauthorized());
    }
    public static class RejectRegistration implements Trigger {
        @Override public void fire(Connection connection, Object[] oldRow, Object[] newRow) throws SQLException { throw new SQLException("合成登记故障", "45000"); }
    }
    @Test void registrationInsertFailureRollsBackItsTaskRatherThanReturningFakeReplay() throws Exception {
        jdbc.execute("CREATE TRIGGER registration_fault BEFORE INSERT ON task_registration FOR EACH ROW CALL 'cn.colla.phaseone.TaskRegistrationIT$RejectRegistration'");
        http.perform(request(team, token, UUID.randomUUID().toString(), "{\"title\":\"rollback\"}")).andExpect(status().isInternalServerError());
        assertThat(count("task_record")).isZero(); assertThat(count("task_registration")).isZero();
    }
    @Test void unrelatedUniqueViolationIsNotTreatedAsReplay() throws Exception {
        create(UUID.randomUUID().toString(), 201);
        jdbc.execute("CREATE UNIQUE INDEX unique_test_title ON task_record(title)");
        http.perform(request(team, token, UUID.randomUUID().toString(), "{\"title\":\"合成影像.dcm\"}")).andExpect(status().isInternalServerError());
        assertThat(count("task_record")).isEqualTo(1); assertThat(count("task_registration")).isEqualTo(1);
    }
    @Test void noTaskReadOrGeneralWriteEndpointIsPublished() throws Exception {
        var data = create(UUID.randomUUID().toString(), 201); String path = "/api/v1/teams/" + team + "/tasks";
        http.perform(get(path).header("Authorization", "Bearer " + token)).andExpect(status().isMethodNotAllowed());
        http.perform(get(path + "/" + data.path("task_id").asText()).header("Authorization", "Bearer " + token)).andExpect(status().isNotFound());
        http.perform(patch(path + "/" + data.path("task_id").asText()).header("Authorization", "Bearer " + token).contentType("application/json").content("{}")).andExpect(status().isNotFound());
    }

    public static class CollidingTaskId implements Trigger {
        static String existingTaskId;
        @Override public void fire(Connection connection, Object[] oldRow, Object[] newRow) { newRow[3] = existingTaskId; }
    }
    @Test void registrationTaskIdUniqueViolationDoesNotReplayUnrelatedKey() throws Exception {
        CollidingTaskId.existingTaskId = create(UUID.randomUUID().toString(), 201).path("task_id").asText();
        jdbc.execute("CREATE TRIGGER registration_fault BEFORE INSERT ON task_registration FOR EACH ROW CALL 'cn.colla.phaseone.TaskRegistrationIT$CollidingTaskId'");
        http.perform(request(team, token, UUID.randomUUID().toString(), "{\"title\":\"unique-fault\"}")).andExpect(status().isInternalServerError());
        assertThat(count("task_record")).isEqualTo(1); assertThat(count("task_registration")).isEqualTo(1);
    }
    public static class TransientCollision implements Trigger {
        static final java.util.concurrent.atomic.AtomicInteger remaining = new java.util.concurrent.atomic.AtomicInteger();
        @Override public void fire(Connection connection, Object[] oldRow, Object[] newRow) throws SQLException {
            if (remaining.getAndDecrement() > 0)
                throw new SQLException("合成已消失的竞争 ON PUBLIC.TASK_REGISTRATION(UID, REGISTRATION_KEY) ", "23505", 23505);
        }
    }
    @Test void disappearedCollisionRetriesOneWholeTransactionAndPermanentCollisionIsBounded() throws Exception {
        jdbc.execute("CREATE TRIGGER registration_fault BEFORE INSERT ON task_registration FOR EACH ROW CALL 'cn.colla.phaseone.TaskRegistrationIT$TransientCollision'");
        TransientCollision.remaining.set(1); create(UUID.randomUUID().toString(), 201);
        assertThat(count("task_record")).isEqualTo(1); assertThat(count("task_registration")).isEqualTo(1);
        TransientCollision.remaining.set(10);
        http.perform(request(team, token, UUID.randomUUID().toString(), "{\"title\":\"busy\"}")).andExpect(status().isConflict()).andExpect(jsonPath("$.error.details.reason").value("IDEMPOTENCY_BUSY"));
        assertThat(TransientCollision.remaining.get()).isEqualTo(8);
        assertThat(count("task_record")).isEqualTo(1); assertThat(count("task_registration")).isEqualTo(1);
    }
    public static class AttemptBarrier implements Trigger {
        static volatile CountDownLatch attempted;
        @Override public void fire(Connection connection, Object[] oldRow, Object[] newRow) { attempted.countDown(); }
    }
    @Test void uncommittedWinnerRollsBackAndWaitingRealSqlContenderCommitsOnlyItsTask() throws Exception {
        String key = UUID.randomUUID().toString(), rolledBackId = UUID.randomUUID().toString();
        var inserted = new CountDownLatch(1); var rollback = new CountDownLatch(1);
        AttemptBarrier.attempted = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var winner = pool.submit(() -> {
                new org.springframework.transaction.support.TransactionTemplate(manager).execute(status -> {
                    jdbc.update("INSERT INTO task_record VALUES(?,?,?,?,JSON '{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)", rolledBackId, team, "合成影像.dcm", uid);
                    jdbc.update("INSERT INTO task_registration VALUES(?,?,?,?,CURRENT_TIMESTAMP)", uid, key, "a".repeat(64), rolledBackId);
                    inserted.countDown();
                    try { if (!rollback.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("等待回滚超时"); }
                    catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IllegalStateException(error); }
                    status.setRollbackOnly(); return null;
                });
            });
            assertThat(inserted.await(10, TimeUnit.SECONDS)).isTrue();
            jdbc.execute("CREATE TRIGGER registration_fault BEFORE INSERT ON task_registration FOR EACH ROW CALL 'cn.colla.phaseone.TaskRegistrationIT$AttemptBarrier'");
            var contender = pool.submit(() -> create(key, 201));
            try { assertThat(AttemptBarrier.attempted.await(10, TimeUnit.SECONDS)).isTrue(); }
            finally { rollback.countDown(); }
            winner.get(10, TimeUnit.SECONDS);
            assertThat(contender.get(10, TimeUnit.SECONDS).path("task_id").asText()).isNotEqualTo(rolledBackId);
        } finally { rollback.countDown(); }
        assertThat(count("task_record")).isEqualTo(1); assertThat(count("task_registration")).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM task_record WHERE task_id=?", Integer.class, rolledBackId)).isZero();
    }
    @Test void repeatedTaskSchemaInitializationPreservesRowsAndAnonymousRequestNeverCreatesTask() throws Exception {
        create(UUID.randomUUID().toString(), 201);
        var init = new org.springframework.jdbc.datasource.init.ResourceDatabasePopulator(new org.springframework.core.io.ClassPathResource("db/V003__tasks.sql"));
        init.execute(jdbc.getDataSource()); init.execute(jdbc.getDataSource());
        http.perform(post("/api/v1/teams/" + team + "/tasks").contentType("application/json").content("{\"title\":\"x\"}")).andExpect(status().isUnauthorized());
        assertThat(count("task_record")).isEqualTo(1); assertThat(count("task_registration")).isEqualTo(1);
    }
}
