package cn.colla.phaseone;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.IntFunction;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.*;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
@Import(InvitationTestSupport.ControlledTime.class)
abstract class InvitationTestSupport {
    static final Instant START = Instant.parse("2026-11-01T00:00:00.123456789Z");
    @TestConfiguration static class ControlledTime {
        @Bean @Primary MutableClock invitationClock() { return new MutableClock(); }
    }
    static class MutableClock extends Clock {
        private volatile Instant now = START;
        public ZoneId getZone() { return ZoneOffset.UTC; }
        public Clock withZone(ZoneId zone) { return Clock.fixed(now, zone); }
        public Instant instant() { return now; }
        void set(Instant value) { now = value; }
    }
    @Autowired MockMvc http;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate jdbc;
    @Autowired MutableClock clock;

    @BeforeEach void cleanInvitations() {
        clock.set(START);
        if (jdbc.queryForObject("SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='TEAM_INVITATION'", Integer.class) > 0)
            jdbc.update("DELETE FROM team_invitation");
        for (String table : List.of("auth_session", "team_member", "team", "app_user")) jdbc.update("DELETE FROM " + table);
    }
    JsonNode register(String name) throws Exception {
        return data(http.perform(post("/api/v1/users").contentType("application/json")
            .content(json.writeValueAsString(Map.of("username", name, "password", "test-password")))).andExpect(status().isCreated()));
    }
    String uid(JsonNode user) { return user.at("/user/uid").asText(); }
    String team(JsonNode user) { return user.path("default_team_id").asText(); }
    String token(JsonNode user) { return "Bearer " + user.path("token").asText(); }
    JsonNode data(ResultActions result) throws Exception { return json.readTree(result.andReturn().getResponse().getContentAsString()).path("data"); }
    ResultActions send(JsonNode owner, String team, String name) throws Exception {
        return http.perform(post("/api/v1/teams/" + team + "/invitations").header("Authorization", token(owner))
            .contentType("application/json").content(json.writeValueAsString(Map.of("username", name))));
    }
    JsonNode invite(JsonNode owner, JsonNode recipient) throws Exception {
        return data(send(owner, team(owner), recipient.at("/user/username").asText()).andExpect(status().isCreated()));
    }
    ResultActions decide(JsonNode user, String id, String decision) throws Exception {
        return http.perform(post("/api/v1/invitations/" + id + "/" + decision).header("Authorization", token(user)));
    }
    int members(JsonNode owner, JsonNode user) { return jdbc.queryForObject("SELECT COUNT(*) FROM team_member WHERE team_id=? AND uid=?", Integer.class, team(owner), uid(user)); }
    int invitations() { return jdbc.queryForObject("SELECT COUNT(*) FROM team_invitation", Integer.class); }
    void reason(ResultActions result, int status, String reason) throws Exception {
        result.andExpect(status().is(status)).andExpect(jsonPath("$.error.details.reason").value(reason));
    }
    List<Integer> concurrent(int count, IntFunction<Callable<Integer>> action) throws Exception {
        var pool = Executors.newFixedThreadPool(count);
        var barrier = new CyclicBarrier(count);
        try {
            var futures = new ArrayList<Future<Integer>>();
            for (int i = 0; i < count; i++) {
                var task = action.apply(i);
                futures.add(pool.submit(() -> { barrier.await(10, TimeUnit.SECONDS); return task.call(); }));
            }
            var results = new ArrayList<Integer>();
            for (var future : futures) results.add(future.get(15, TimeUnit.SECONDS));
            return results;
        } finally { pool.shutdownNow(); assertThat(pool.awaitTermination(10, TimeUnit.SECONDS)).isTrue(); }
    }
}
