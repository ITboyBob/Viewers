package cn.colla.phaseone;

import java.sql.*;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.h2.api.Trigger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.test.context.TestPropertySource;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@TestPropertySource(properties = "colla.database-name=invitation_decision_it")
class InvitationDecisionIT extends InvitationTestSupport {
    @AfterEach void dropFailureTrigger() { jdbc.execute("DROP TRIGGER IF EXISTS invitation_fail"); }

    public static class FailDecision implements Trigger {
        static final AtomicInteger membersSeen = new AtomicInteger();
        public void fire(Connection connection, Object[] oldRow, Object[] newRow) throws SQLException {
            try (var statement = connection.prepareStatement("SELECT COUNT(*) FROM team_member WHERE team_id=? AND uid=?")) {
                statement.setObject(1, oldRow[1]); statement.setObject(2, oldRow[3]);
                try (var rows = statement.executeQuery()) { rows.next(); membersSeen.set(rows.getInt(1)); }
            }
            throw new SQLException("测试注入：成员已写入后中断决策更新");
        }
    }

    @Test void acceptingCreatesExactlyOneAnnotatorAndCurrentContextReflectsMembership() throws Exception {
        var owner = register("owner"); var user = register("recipient"); var invitation = invite(owner, user);
        String id = invitation.path("invitation_id").asText();
        var accepted = data(decide(user, id, "accept").andExpect(status().isOk()));
        assertThat(accepted.path("decision").asText()).isEqualTo("accepted");
        assertThat(accepted.path("decided_at").asText()).isEqualTo(START.toString());
        var repeated = data(decide(user, id, "accept").andExpect(status().isOk()));
        assertThat(repeated).isEqualTo(accepted); assertThat(members(owner, user)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT role FROM team_member WHERE team_id=? AND uid=?", String.class, team(owner), uid(user))).isEqualTo("annotator");
        assertThat(jdbc.queryForObject("SELECT owner_uid FROM team WHERE team_id=?", String.class, team(owner))).isEqualTo(uid(owner));
        assertThat(jdbc.queryForObject("SELECT role FROM team_member WHERE team_id=? AND uid=?", String.class, team(owner), uid(owner))).isEqualTo("owner");
        var current = data(http.perform(get("/api/v1/auth/sessions/current").header("Authorization", token(user))).andExpect(status().isOk()));
        assertThat(current.path("memberships")).hasSize(2);
        assertThat(current.path("default_team_id").asText()).isEqualTo(team(user));
        reason(decide(user, id, "reject"), 409, "DECISION_CONFLICT");
    }

    @Test void rejectionIsIdempotentDoesNotCreateMemberOrReleaseCooldown() throws Exception {
        var owner = register("owner"); var user = register("recipient"); var invitation = invite(owner, user);
        String id = invitation.path("invitation_id").asText();
        var rejected = data(decide(user, id, "reject").andExpect(status().isOk()));
        assertThat(rejected.path("decision").asText()).isEqualTo("rejected");
        assertThat(data(decide(user, id, "reject").andExpect(status().isOk()))).isEqualTo(rejected);
        assertThat(members(owner, user)).isZero();
        reason(decide(user, id, "accept"), 409, "DECISION_CONFLICT");
        reason(send(owner, team(owner), "recipient"), 409, "INVITATION_COOLDOWN");
        clock.set(START.plusSeconds(300)); invite(owner, user); assertThat(invitations()).isEqualTo(2);
    }

    @ParameterizedTest @ValueSource(strings = {"accept", "reject"})
    void onlyRecipientCanDecideAndMissingIdIsIndistinguishable(String decision) throws Exception {
        var owner = register("owner"); var user = register("recipient"); var stranger = register("stranger");
        var invitation = invite(owner, user); String id = invitation.path("invitation_id").asText();
        String hidden = decide(stranger, id, decision).andExpect(status().isNotFound()).andReturn().getResponse().getContentAsString();
        assertThat(decide(stranger, "unknown", decision).andExpect(status().isNotFound()).andReturn().getResponse().getContentAsString()).isEqualTo(hidden);
        decide(owner, id, decision).andExpect(status().isNotFound());
        http.perform(post("/api/v1/invitations/" + id + "/" + decision)).andExpect(status().isUnauthorized());
        assertThat(members(owner, user)).isZero();
    }

    @ParameterizedTest @ValueSource(strings = {"accept", "reject"})
    void exactExpiryAndAfterDeadlineRejectPendingWithoutMutation(String decision) throws Exception {
        var owner = register("owner"); var user = register("recipient"); var invitation = invite(owner, user);
        String id = invitation.path("invitation_id").asText();
        for (var at : List.of(START.plusSeconds(300), START.plusSeconds(301))) {
            clock.set(at); reason(decide(user, id, decision), 409, "INVITATION_EXPIRED");
        }
        assertThat(jdbc.queryForObject("SELECT decision FROM team_invitation WHERE invitation_id=?", String.class, id)).isEqualTo("pending");
        assertThat(members(owner, user)).isZero();
    }

    @ParameterizedTest @ValueSource(strings = {"accept", "reject"})
    void oneNanosecondBeforeDeadlineWorksButExpiredReplayAndOppositeAlwaysFail(String decision) throws Exception {
        var owner = register("owner"); var user = register("recipient"); var invitation = invite(owner, user);
        String id = invitation.path("invitation_id").asText();
        clock.set(START.plusSeconds(300).minusNanos(1)); decide(user, id, decision).andExpect(status().isOk());
        clock.set(START.plusSeconds(300));
        reason(decide(user, id, decision), 409, "INVITATION_EXPIRED");
        reason(decide(user, id, decision.equals("accept") ? "reject" : "accept"), 409, "INVITATION_EXPIRED");
        assertThat(members(owner, user)).isEqualTo(decision.equals("accept") ? 1 : 0);
    }

    @Test void noRoleUidOrUnknownBusinessBodyCanBeInjectedIntoDecision() throws Exception {
        var owner = register("owner"); var user = register("recipient"); var invitation = invite(owner, user);
        String path = "/api/v1/invitations/" + invitation.path("invitation_id").asText();
        for (String operation : List.of("accept", "reject")) {
            for (String body : List.of("{\"role\":\"owner\"}", "{\"uid\":\"forged\"}", "{\"decision\":\"accepted\"}"))
                http.perform(post(path + "/" + operation).header("Authorization", token(user)).contentType("application/json").content(body))
                    .andExpect(status().isUnprocessableEntity());
            http.perform(post(path + "/" + operation).header("Authorization", token(user)).param("uid", uid(owner)))
                .andExpect(status().isUnprocessableEntity());
        }
        assertThat(members(owner, user)).isZero();
    }

    @Test void concurrentAcceptsReturnSameOutcomeAndOnlyInsertOneMember() throws Exception {
        var owner = register("owner"); var user = register("recipient"); var invitation = invite(owner, user);
        String id = invitation.path("invitation_id").asText();
        assertThat(concurrent(6, i -> () -> decide(user, id, "accept").andReturn().getResponse().getStatus())).containsOnly(200);
        assertThat(members(owner, user)).isEqualTo(1);
    }

    @Test void concurrentAcceptAndRejectOnlyOneDecisionWins() throws Exception {
        var owner = register("owner"); var user = register("recipient"); var invitation = invite(owner, user);
        String id = invitation.path("invitation_id").asText();
        assertThat(concurrent(2, i -> () -> decide(user, id, i == 0 ? "accept" : "reject").andReturn().getResponse().getStatus()))
            .containsExactlyInAnyOrder(200, 409);
        var decision = jdbc.queryForObject("SELECT decision FROM team_invitation WHERE invitation_id=?", String.class, id);
        assertThat(members(owner, user)).isEqualTo(decision.equals("accepted") ? 1 : 0);
    }

    @Test void concurrentSendAndAcceptKeepLockOrderWithoutDeadlockOrDuplicateMember() throws Exception {
        var owner = register("owner"); var user = register("recipient"); var invitation = invite(owner, user);
        String id = invitation.path("invitation_id").asText();
        assertThat(concurrent(2, i -> () -> (i == 0 ? decide(user, id, "accept") : send(owner, team(owner), "recipient"))
            .andReturn().getResponse().getStatus())).containsExactlyInAnyOrder(200, 409);
        assertThat(members(owner, user)).isEqualTo(1); assertThat(invitations()).isEqualTo(1);
    }

    @Test void pendingInvitationCannotOverwritePreexistingMember() throws Exception {
        var owner = register("owner"); var user = register("recipient"); var invitation = invite(owner, user);
        jdbc.update("INSERT INTO team_member VALUES(?,?,'annotator',CURRENT_TIMESTAMP)", team(owner), uid(user));
        reason(decide(user, invitation.path("invitation_id").asText(), "accept"), 409, "ALREADY_MEMBER");
        assertThat(members(owner, user)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT decision FROM team_invitation", String.class)).isEqualTo("pending");
    }

    @Test void failedDecisionUpdateRollsBackInsertedMembershipAndAllowsRetry() throws Exception {
        var owner = register("owner"); var user = register("recipient"); var invitation = invite(owner, user);
        String id = invitation.path("invitation_id").asText();
        FailDecision.membersSeen.set(0);
        jdbc.execute("CREATE TRIGGER invitation_fail BEFORE UPDATE ON team_invitation FOR EACH ROW CALL 'cn.colla.phaseone.InvitationDecisionIT$FailDecision'");
        decide(user, id, "accept").andExpect(status().isInternalServerError());
        assertThat(FailDecision.membersSeen.get()).isEqualTo(1);
        assertThat(members(owner, user)).isZero();
        assertThat(jdbc.queryForObject("SELECT decision FROM team_invitation", String.class)).isEqualTo("pending");
        assertThat(jdbc.queryForObject("SELECT decided_at FROM team_invitation", Object.class)).isNull();
        jdbc.execute("DROP TRIGGER invitation_fail");
        decide(user, id, "accept").andExpect(status().isOk()); assertThat(members(owner, user)).isEqualTo(1);
    }
}
