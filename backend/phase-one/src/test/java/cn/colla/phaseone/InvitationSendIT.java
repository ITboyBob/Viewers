package cn.colla.phaseone;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import static cn.colla.phaseone.identity.IdentityRepository.utc;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.test.context.TestPropertySource;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@TestPropertySource(properties = "colla.database-name=invitation_send_it")
class InvitationSendIT extends InvitationTestSupport {
    @Autowired DataSource source;

    @Test void sendCreatesPendingInvitationNotMembershipAndProjectsOnlyPublicFields() throws Exception {
        var owner = register("owner"); var recipient = register("recipient");
        var invitation = data(send(owner, team(owner), " recipient ").andExpect(status().isCreated()));
        assertThat(invitation.path("decision").asText()).isEqualTo("pending");
        assertThat(invitation.path("team_id").asText()).isEqualTo(team(owner));
        assertThat(invitation.path("team_name").asText()).isEqualTo("owner的团队");
        assertThat(invitation.at("/inviter/uid").asText()).isEqualTo(uid(owner));
        assertThat(invitation.at("/inviter/avatar_url").isNull()).isTrue();
        assertThat(invitation.path("invitee_uid").asText()).isEqualTo(uid(recipient));
        assertThat(invitation.path("created_at").asText()).isEqualTo(START.toString());
        assertThat(invitation.path("expires_at").asText()).isEqualTo(START.plusSeconds(300).toString());
        assertThat(invitation.path("decided_at").isNull()).isTrue();
        assertThat(invitation.toString()).doesNotContain("password", "email", "token");
        assertThat(members(owner, recipient)).isZero(); assertThat(invitations()).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM team_member", Integer.class)).isEqualTo(2);
    }

    @Test void validMemberMaySendButNonmemberAndAnonymousCannotSend() throws Exception {
        var owner = register("owner"); var user = register("user"); var target = register("target");
        send(user, team(owner), "target").andExpect(status().isNotFound());
        jdbc.update("INSERT INTO team_member VALUES(?,?,'annotator',CURRENT_TIMESTAMP)", team(owner), uid(user));
        send(user, team(owner), "target").andExpect(status().isCreated());
        send(owner, "absent", "target").andExpect(status().isNotFound());
        http.perform(post("/api/v1/teams/" + team(owner) + "/invitations").contentType("application/json").content("{\"username\":\"target\"}"))
            .andExpect(status().isUnauthorized());
        assertThat(invitations()).isEqualTo(1);
    }

    @Test void invalidSelfUnknownDisabledAndAlreadyMemberAreRejected() throws Exception {
        var owner = register("owner"); var recipient = register("recipient");
        for (String name : List.of("owner", "missing")) reason(send(owner, team(owner), name), 422, "INVALID_INVITEE");
        jdbc.update("UPDATE app_user SET status='disabled' WHERE uid=?", uid(recipient));
        reason(send(owner, team(owner), "recipient"), 422, "INVALID_INVITEE");
        jdbc.update("UPDATE app_user SET status='active' WHERE uid=?", uid(recipient));
        jdbc.update("INSERT INTO team_member VALUES(?,?,'annotator',CURRENT_TIMESTAMP)", team(owner), uid(recipient));
        reason(send(owner, team(owner), "recipient"), 409, "ALREADY_MEMBER");
        assertThat(invitations()).isZero();
    }

    @Test void malformedPayloadHasNoPartialWriteOrRoleBypass() throws Exception {
        var owner = register("owner"); register("recipient");
        for (String body : List.of("{}", "{\"username\":null}", "{\"username\":\" \"}", "{\"username\":123}",
                "{\"username\":\"recipient\",\"role\":\"owner\"}", "{\"username\":\"recipient\",\"uid\":\"forged\"}",
                "{\"username\":\"recipient\",\"task_id\":\"forged\"}", "{\"username\":\"" + "x".repeat(65) + "\"}")) {
            http.perform(post("/api/v1/teams/" + team(owner) + "/invitations").header("Authorization", token(owner))
                .contentType("application/json").content(body)).andExpect(status().isUnprocessableEntity());
        }
        assertThat(invitations()).isZero();
        http.perform(post("/api/v1/teams/" + team(owner) + "/members").header("Authorization", token(owner))
            .contentType("application/json").content("{\"username\":\"recipient\"}")).andExpect(status().is4xxClientError());
    }

    @Test void exactFiveMinuteWindowAndNanosecondExpiryPermitNewSendOnlyAtDeadline() throws Exception {
        var owner = register("owner"); var recipient = register("recipient"); var first = invite(owner, recipient);
        clock.set(START.plusMillis(299999)); reason(send(owner, team(owner), "recipient"), 409, "INVITATION_COOLDOWN");
        clock.set(START.plusSeconds(300).minusNanos(1)); reason(send(owner, team(owner), "recipient"), 409, "INVITATION_COOLDOWN");
        clock.set(START.plus(Duration.ofMinutes(5)));
        var second = invite(owner, recipient);
        assertThat(second.path("invitation_id")).isNotEqualTo(first.path("invitation_id"));
        assertThat(invitations()).isEqualTo(2); assertThat(members(owner, recipient)).isZero();
    }

    @Test void concurrentSendsUseRealSqlLockAndOnlyOneWins() throws Exception {
        var owner = register("owner"); register("recipient");
        var statuses = concurrent(6, i -> () -> send(owner, team(owner), "recipient").andReturn().getResponse().getStatus());
        assertThat(statuses).containsOnly(201, 409).filteredOn(s -> s == 201).hasSize(1);
        assertThat(invitations()).isEqualTo(1);
    }

    @Test void differentTeamsAndDifferentRecipientsHaveIndependentWindows() throws Exception {
        var a = register("a"); var b = register("b"); var c = register("c"); var d = register("d");
        invite(a, c); invite(b, c); invite(a, d);
        assertThat(invitations()).isEqualTo(3);
    }

    @Test void h2EnforcesForeignKeysDecisionConsistencyExpiryAndMemberUniqueness() throws Exception {
        var owner = register("owner"); var user = register("recipient"); var invitation = invite(owner, user);
        String insert = "INSERT INTO team_invitation(invitation_id,team_id,inviter_uid,invitee_uid,created_at,expires_at,decision,decided_at) VALUES(?,?,?,?,?,?,?,?)";
        for (var values : List.<Object[]>of(
            new Object[]{UUID.randomUUID().toString(), "missing-team", uid(owner), uid(user), utc(START), utc(START.plusSeconds(300)), "pending", null},
            new Object[]{UUID.randomUUID().toString(), team(owner), "missing-user", uid(user), utc(START), utc(START.plusSeconds(300)), "pending", null},
            new Object[]{UUID.randomUUID().toString(), team(owner), uid(owner), "missing-user", utc(START), utc(START.plusSeconds(300)), "pending", null},
            new Object[]{UUID.randomUUID().toString(), team(owner), uid(owner), uid(owner), utc(START), utc(START.plusSeconds(300)), "pending", null},
            new Object[]{UUID.randomUUID().toString(), team(owner), uid(owner), uid(user), utc(START), utc(START), "pending", null},
            new Object[]{UUID.randomUUID().toString(), team(owner), uid(owner), uid(user), utc(START), utc(START.minusNanos(1)), "pending", null},
            new Object[]{UUID.randomUUID().toString(), team(owner), uid(owner), uid(user), utc(START), utc(START.plusSeconds(300)), "unknown", null},
            new Object[]{UUID.randomUUID().toString(), team(owner), uid(owner), uid(user), utc(START), utc(START.plusSeconds(300)), "pending", utc(START)},
            new Object[]{UUID.randomUUID().toString(), team(owner), uid(owner), uid(user), utc(START), utc(START.plusSeconds(300)), "accepted", null},
            new Object[]{UUID.randomUUID().toString(), team(owner), uid(owner), uid(user), utc(START), utc(START.plusSeconds(300)), "rejected", null},
            new Object[]{invitation.path("invitation_id").asText(), team(owner), uid(owner), uid(user), utc(START), utc(START.plusSeconds(300)), "pending", null})) {
            assertThatThrownBy(() -> jdbc.update(insert, values)).isInstanceOf(DataIntegrityViolationException.class);
        }
        assertThatThrownBy(() -> jdbc.update("INSERT INTO team_member VALUES(?,?,'annotator',?)", team(owner), uid(owner), utc(START)))
            .isInstanceOf(DataIntegrityViolationException.class);
        assertThat(invitations()).isEqualTo(1); assertThat(members(owner, user)).isZero();
    }

    @Test void queryParametersCannotOverrideSenderAndDisabledSenderIsRejected() throws Exception {
        var owner = register("owner"); var user = register("recipient");
        http.perform(post("/api/v1/teams/" + team(owner) + "/invitations").header("Authorization", token(owner))
            .param("uid", uid(user)).contentType("application/json").content("{\"username\":\"recipient\"}"))
            .andExpect(status().isUnprocessableEntity());
        jdbc.update("UPDATE app_user SET status='disabled' WHERE uid=?", uid(owner));
        send(owner, team(owner), "recipient").andExpect(status().isUnauthorized());
        assertThat(invitations()).isZero();
    }

    @Test void repeatedSchemaInitializationRetainsInvitations() throws Exception {
        var owner = register("owner"); var recipient = register("recipient"); invite(owner, recipient);
        var init = new ResourceDatabasePopulator(new ClassPathResource("db/V002__invitations.sql"));
        init.execute(source); init.execute(source);
        assertThat(invitations()).isEqualTo(1); assertThat(members(owner, recipient)).isZero();
    }
}
