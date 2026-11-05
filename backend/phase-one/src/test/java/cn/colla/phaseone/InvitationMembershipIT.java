package cn.colla.phaseone;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.test.context.TestPropertySource;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@TestPropertySource(properties = "colla.database-name=invitation_membership_it")
class InvitationMembershipIT extends InvitationTestSupport {
    void join(JsonNode owner, JsonNode user) throws Exception {
        decide(user, invite(owner, user).path("invitation_id").asText(), "accept").andExpect(status().isOk());
    }
    String sentPath(JsonNode owner) { return "/api/v1/teams/" + team(owner) + "/invitations/sent"; }
    JsonNode sent(JsonNode actor, JsonNode owner, String query) throws Exception {
        return json.readTree(http.perform(get(sentPath(owner) + query).header("Authorization", token(actor)))
            .andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
    }
    @Test void memberMaySendAndReadButCannotInspectAnotherSendersDeadlines() throws Exception {
        var a = register("a"); var c = register("c"); var b = register("b"); join(a, c);
        var first = data(send(a, team(a), "b").andExpect(status().isCreated()));
        var other = data(send(c, team(a), "b").andExpect(status().isCreated()));
        http.perform(get("/api/v1/teams/" + team(a) + "/members").header("Authorization", token(c)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.meta.total").value(2));
        assertThat(sent(c, a, "").path("data")).hasSize(1);
        assertThat(sent(c, a, "").at("/data/0/invitation_id")).isEqualTo(other.path("invitation_id"));
        assertThat(sent(c, a, "").toString()).doesNotContain(first.path("invitation_id").asText(), "decision", "read_at");
        reason(send(c, team(a), "b"), 409, "INVITATION_COOLDOWN");
        assertThat(sent(a, a, "").at("/meta/server_time").asText()).isEqualTo(START.toString());
        http.perform(get(sentPath(a)).header("Authorization", token(b))).andExpect(status().isNotFound());
        http.perform(get(sentPath(a))).andExpect(status().isUnauthorized());
    }
    @Test void acceptanceInvalidatesOtherPendingInvitationsWithoutChangingOriginalDeadlinesOrReads() throws Exception {
        var a = register("a"); var c = register("c"); var b = register("b"); var otherTeam = register("other"); join(a, c);
        var one = data(send(a, team(a), "b").andExpect(status().isCreated()));
        var two = data(send(c, team(a), "b").andExpect(status().isCreated()));
        var unrelated = invite(otherTeam, b);
        decide(b, two.path("invitation_id").asText(), "accept").andExpect(status().isOk());
        for (String decision : List.of("accept", "reject")) reason(decide(b, one.path("invitation_id").asText(), decision), 409, "INVITATION_EXPIRED");
        decide(b, two.path("invitation_id").asText(), "accept").andExpect(status().isOk());
        assertThat(sent(a, a, "").at("/data/1/expires_at").asText()).isEqualTo(START.plusSeconds(300).toString());
        assertThat(sent(c, a, "").path("data")).hasSize(1);
        var row = jdbc.queryForMap("SELECT decision,decided_at,read_at,expires_at FROM team_invitation WHERE invitation_id=?", one.path("invitation_id").asText());
        assertThat(row.get("DECISION")).isEqualTo("pending"); assertThat(row.get("DECIDED_AT")).isNull(); assertThat(row.get("READ_AT")).isNull();
        decide(b, unrelated.path("invitation_id").asText(), "accept").andExpect(status().isOk());
        clock.set(START.plusSeconds(300)); assertThat(sent(a, a, "").path("data")).isEmpty();
    }
    @Test void concurrentDifferentInvitationsOnlyOneAcceptsAndMembershipIsUnique() throws Exception {
        var a = register("a"); var c = register("c"); var b = register("b"); join(a, c);
        var ids = List.of(data(send(a, team(a), "b").andExpect(status().isCreated())).path("invitation_id").asText(),
            data(send(c, team(a), "b").andExpect(status().isCreated())).path("invitation_id").asText());
        assertThat(concurrent(2, i -> () -> decide(b, ids.get(i), "accept").andReturn().getResponse().getStatus()))
            .containsExactlyInAnyOrder(200, 409);
        assertThat(members(a, b)).isEqualTo(1);
    }
    @Test void sentIncludesRejectedAndAcceptedRecordsAndUsesStablePaging() throws Exception {
        var a = register("a"); var b = register("b"); var c = register("c");
        decide(b, invite(a, b).path("invitation_id").asText(), "reject").andExpect(status().isOk());
        decide(c, invite(a, c).path("invitation_id").asText(), "accept").andExpect(status().isOk());
        var one = sent(a, a, "?page_size=1"); var two = sent(a, a, "?page=2&page_size=1");
        assertThat(one.at("/meta/total").asInt()).isEqualTo(2);
        assertThat(one.at("/data/0/invitation_id").asText()).isLessThan(two.at("/data/0/invitation_id").asText());
        assertThat(one.at("/data/0/invitee/username").isTextual()).isTrue();
        assertThat(sent(a, a, "?page=3&page_size=1").path("data")).isEmpty();
        jdbc.update("DELETE FROM team_member WHERE team_id=? AND uid=?", team(a), uid(a));
        http.perform(get(sentPath(a)).header("Authorization", token(a))).andExpect(status().isNotFound());
    }
    @ParameterizedTest @ValueSource(strings={"page=0", "page=1&page=2", "page_size=101", "inviter_uid=x", "invitee_username=b", "eligible=true", "page_size=NaN"})
    void sentRejectsFiltersAndInvalidPaging(String query) throws Exception {
        var a=register("a"); http.perform(get(sentPath(a)+"?"+query).header("Authorization",token(a))).andExpect(status().isUnprocessableEntity());
    }

    public static class FailInvalidation implements org.h2.api.Trigger {
        public void fire(java.sql.Connection connection, Object[] oldRow, Object[] newRow) throws java.sql.SQLException {
            if (newRow[newRow.length - 1] != null) throw new java.sql.SQLException("测试：连带失效失败");
        }
    }
    @Test void invalidationFailureRollsBackMembershipAndAllInvitationChanges() throws Exception {
        var a=register("a"); var c=register("c"); var b=register("b"); join(a,c);
        var one=data(send(a,team(a),"b").andExpect(status().isCreated()));
        var two=data(send(c,team(a),"b").andExpect(status().isCreated()));
        jdbc.execute("CREATE TRIGGER fail_invalidation BEFORE UPDATE ON team_invitation FOR EACH ROW CALL 'cn.colla.phaseone.InvitationMembershipIT$FailInvalidation'");
        try {
            decide(b,one.path("invitation_id").asText(),"accept").andExpect(status().is5xxServerError());
            assertThat(members(a,b)).isZero();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM team_invitation WHERE invitee_uid=? AND (decision<>'pending' OR invalidated_at IS NOT NULL)",Integer.class,uid(b))).isZero();
            assertThat(sent(c,a,"").at("/data/0/invitation_id")).isEqualTo(two.path("invitation_id"));
        } finally { jdbc.execute("DROP TRIGGER fail_invalidation"); }
        decide(b,one.path("invitation_id").asText(),"accept").andExpect(status().isOk());
    }
}
