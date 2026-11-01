package cn.colla.phaseone;

import java.sql.DriverManager;
import java.time.OffsetDateTime;
import java.util.UUID;
import javax.sql.DataSource;
import com.zaxxer.hikari.HikariDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.test.web.servlet.MockMvc;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(properties = "colla.database-name=runtime_it")
@AutoConfigureMockMvc
class RuntimeDatabaseIT {
    @Autowired DataSource dataSource;
    @Autowired JdbcTemplate jdbc;
    @Autowired MockMvc http;

    @BeforeEach void clean() {
        jdbc.update("DELETE FROM auth_session");
        jdbc.update("DELETE FROM team_member");
        jdbc.update("DELETE FROM team");
        jdbc.update("DELETE FROM app_user");
    }

    static void insertUser(JdbcTemplate db, String uid) {
        var now = OffsetDateTime.now();
        db.update("INSERT INTO app_user(uid,username,password_hash,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)", uid, uid, "test-only-hash", now, now);
    }

    @Test void independentConnectionsShareNamedDatabaseAndReleasedConnectionsKeepRows() throws Exception {
        var url = ((HikariDataSource) dataSource).getJdbcUrl();
        assertThat(url).contains("mem:runtime_it;").contains("DB_CLOSE_DELAY=-1");
        try (var first = dataSource.getConnection(); var second = dataSource.getConnection()) {
            assertThat(first).isNotSameAs(second);
            insertUser(new JdbcTemplate(new org.springframework.jdbc.datasource.SingleConnectionDataSource(first, true)), "connection-user");
            try (var query = second.createStatement(); var rows = query.executeQuery("SELECT COUNT(*) FROM app_user")) {
                rows.next(); assertThat(rows.getInt(1)).isEqualTo(1);
            }
        }
        try (var fresh = DriverManager.getConnection(url, "sa", ""); var s = fresh.createStatement(); var r = s.executeQuery("SELECT COUNT(*) FROM app_user")) {
            r.next(); assertThat(r.getInt(1)).isEqualTo(1);
        }
        String isolated = "jdbc:h2:mem:released_" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1";
        try (var last = DriverManager.getConnection(isolated); var s = last.createStatement()) {
            s.execute("CREATE TABLE probe(id INT)"); s.execute("INSERT INTO probe VALUES(1)");
        }
        try (var reopened = DriverManager.getConnection(isolated); var s = reopened.createStatement(); var r = s.executeQuery("SELECT COUNT(*) FROM probe")) {
            r.next(); assertThat(r.getInt(1)).isEqualTo(1);
            s.execute("SHUTDOWN");
        }
    }

    @Test void repeatedInitializationIsNonDestructive() {
        insertUser(jdbc, "repeat-user");
        var initializer = new ResourceDatabasePopulator(new ClassPathResource("db/V001__identity.sql"));
        initializer.execute(dataSource); initializer.execute(dataSource);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM app_user", Integer.class)).isEqualTo(1);
    }

    @Test void ordinaryRequestsNeverReinitialize() throws Exception {
        insertUser(jdbc, "request-user");
        http.perform(get("/actuator/health")).andExpect(status().isOk());
        http.perform(get("/api/v1/auth/sessions/current")).andExpect(status().isUnauthorized());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM app_user", Integer.class)).isEqualTo(1);
    }

    @Test void separateApplicationContextsHaveSeparateDataAndSessionDigests() {
        String name = "context_" + UUID.randomUUID();
        try (var a = new SpringApplicationBuilder(PhaseOneApplication.class).run("--server.port=0", "--colla.database-name=" + name + "_a");
             var b = new SpringApplicationBuilder(PhaseOneApplication.class).run("--server.port=0", "--colla.database-name=" + name + "_b")) {
            var first = a.getBean(JdbcTemplate.class); var second = b.getBean(JdbcTemplate.class);
            insertUser(first, "context-user");
            first.update("INSERT INTO auth_session VALUES(?,?,?,?)", "a".repeat(64), "context-user", OffsetDateTime.now(), OffsetDateTime.now().plusHours(8));
            assertThat(first.queryForObject("SELECT COUNT(*) FROM auth_session", Integer.class)).isEqualTo(1);
            assertThat(second.queryForObject("SELECT COUNT(*) FROM auth_session", Integer.class)).isZero();
            assertThat(second.queryForObject("SELECT COUNT(*) FROM app_user", Integer.class)).isZero();
        }
    }
}
