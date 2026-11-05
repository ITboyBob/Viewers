package cn.colla.phaseone;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.test.context.TestPropertySource;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@TestPropertySource(properties = "colla.database-name=invitation_read_it")
class InvitationReadIT extends InvitationTestSupport {
    static final String NOTIFICATIONS = "/api/v1/notifications/team-invitations";
    JsonNode read(JsonNode user, String path) throws Exception {
        return json.readTree(http.perform(get(path).header("Authorization", token(user))).andExpect(status().isOk())
            .andReturn().getResponse().getContentAsString());
    }
    String membersPath(JsonNode user) { return "/api/v1/teams/" + team(user) + "/members"; }

    @Test void notificationsAndTotalAreRecipientScopedWithStableTieBreakingAndPagination() throws Exception {
        var a = register("a"); var b = register("b"); var c = register("c"); var user = register("recipient"); var stranger = register("stranger");
        var expected = new ArrayList<String>();
        for (var owner : List.of(a, b, c)) expected.add(invite(owner, user).path("invitation_id").asText());
        invite(a, stranger);
        Collections.sort(expected);
        var first = read(user, NOTIFICATIONS + "?page=1&page_size=2");
        var second = read(user, NOTIFICATIONS + "?page=2&page_size=2");
        assertThat(first.at("/meta/total").asInt()).isEqualTo(3);
        assertThat(first.at("/meta/page").asInt()).isEqualTo(1); assertThat(first.at("/meta/page_size").asInt()).isEqualTo(2);
        assertThat(second.at("/meta/total").asInt()).isEqualTo(3);
        var actual = new ArrayList<String>();
        for (var envelope : List.of(first, second)) for (var item : envelope.path("data")) {
            actual.add(item.path("invitation_id").asText()); assertThat(item.path("invitee_uid").asText()).isEqualTo(uid(user));
        }
        assertThat(actual).containsExactlyElementsOf(expected);
        assertThat(read(user, NOTIFICATIONS + "?page=1&page_size=2")).isEqualTo(first);
        assertThat(read(user, NOTIFICATIONS).at("/meta/page_size").asInt()).isEqualTo(20);
        assertThat(read(user, NOTIFICATIONS + "?page_size=100").path("data")).hasSize(3);
        assertThat(read(user, NOTIFICATIONS + "?page=2147483647&page_size=100").path("data")).isEmpty();
        for (var other : List.of(a, b, c)) {
            var empty = read(other, NOTIFICATIONS); assertThat(empty.path("data")).isEmpty(); assertThat(empty.at("/meta/total").asInt()).isZero();
        }
        assertThat(read(stranger, NOTIFICATIONS).at("/meta/total").asInt()).isEqualTo(1);
    }

    @Test void newestFirstAndAllDecisionsAndExpiredPendingRemainVisibleWithoutReadMutation() throws Exception {
        var owner = register("owner"); var user = register("recipient");
        var first = invite(owner, user); decide(user, first.path("invitation_id").asText(), "reject").andExpect(status().isOk());
        clock.set(START.plusSeconds(300)); var pending = invite(owner, user);
        clock.set(START.plusSeconds(600)); var last = invite(owner, user); decide(user, last.path("invitation_id").asText(), "accept").andExpect(status().isOk());
        clock.set(START.plusSeconds(900));
        var before = jdbc.queryForList("SELECT * FROM team_invitation ORDER BY invitation_id");
        int memberCount = jdbc.queryForObject("SELECT COUNT(*) FROM team_member", Integer.class);
        var list = read(user, NOTIFICATIONS).path("data");
        assertThat(list).hasSize(3);
        assertThat(list.get(0).path("decision").asText()).isEqualTo("accepted");
        assertThat(list.get(1).path("invitation_id")).isEqualTo(pending.path("invitation_id"));
        assertThat(list.get(1).path("decision").asText()).isEqualTo("pending");
        assertThat(list.get(2).path("decision").asText()).isEqualTo("rejected");
        read(user, NOTIFICATIONS); read(owner, membersPath(owner));
        assertThat(jdbc.queryForList("SELECT * FROM team_invitation ORDER BY invitation_id")).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM team_member", Integer.class)).isEqualTo(memberCount);
    }

    @ParameterizedTest @ValueSource(strings = {"page=0", "page=-1", "page=abc", "page=1.5", "page=2147483648", "page=", "page=1&page=2",
        "page_size=0", "page_size=101", "page_size=-1", "page_size=abc", "page_size=", "page_size=99999999999999999999999999",
        "uid=forged", "invitee_uid=forged", "sort=password_hash", "decision=pending", "team_id=forged"})
    void invalidPagingAndUnauthorizedFiltersFailClosedForBothLists(String query) throws Exception {
        var owner = register("owner");
        for (String path : List.of(NOTIFICATIONS, membersPath(owner)))
            http.perform(get(path + "?" + query).header("Authorization", token(owner))).andExpect(status().isUnprocessableEntity());
    }

    @Test void membersSeeAcceptedMembersOnlyAndNonmembersGet404() throws Exception {
        var owner = register("owner"); var user = register("recipient"); var pending = register("pending"); var stranger = register("stranger");
        var invitation = invite(owner, user); invite(owner, pending);
        assertThat(read(owner, membersPath(owner)).at("/meta/total").asInt()).isEqualTo(1);
        decide(user, invitation.path("invitation_id").asText(), "accept").andExpect(status().isOk());
        var response = read(owner, membersPath(owner) + "?page_size=1");
        assertThat(response.path("data")).hasSize(1); assertThat(response.at("/meta/total").asInt()).isEqualTo(2);
        var all = read(owner, membersPath(owner)).path("data");
        assertThat(all).hasSize(2);
        for (var member : all) {
            assertThat(member.size()).isEqualTo(5); assertThat(member.has("joined_at")).isTrue(); assertThat(member.get("avatar_url").isNull()).isTrue();
            if (member.path("uid").asText().equals(uid(user))) assertThat(member.path("role").asText()).isEqualTo("annotator");
        }
        http.perform(get(membersPath(owner)).header("Authorization", token(user))).andExpect(status().isOk());
        http.perform(get(membersPath(owner)).header("Authorization", token(stranger))).andExpect(status().isNotFound());
        http.perform(get("/api/v1/teams/missing/members").header("Authorization", token(owner))).andExpect(status().isNotFound());
        for (String path : List.of(NOTIFICATIONS, membersPath(owner))) http.perform(get(path)).andExpect(status().isUnauthorized());
    }

    @Test void readProjectionUsesLiveTeamAndUserNamesAndNeverLeaksPrivateFields() throws Exception {
        var owner = register("owner"); var user = register("recipient"); var invitation = invite(owner, user);
        jdbc.update("UPDATE team SET name='改名团队' WHERE team_id=?", team(owner));
        jdbc.update("UPDATE app_user SET username='renamed',avatar_url='/avatar.svg',email='private@example.invalid' WHERE uid=?", uid(owner));
        var notifications = read(user, NOTIFICATIONS);
        assertThat(notifications.at("/data/0/team_name").asText()).isEqualTo("改名团队");
        assertThat(notifications.at("/data/0/inviter/username").asText()).isEqualTo("renamed");
        assertThat(notifications.at("/data/0/inviter/avatar_url").asText()).isEqualTo("/avatar.svg");
        assertThat(read(owner, membersPath(owner)).at("/data/0/username").asText()).isEqualTo("renamed");
        for (var response : List.of(notifications, read(owner, membersPath(owner))))
            assertThat(response.toString()).doesNotContain("password", "hash", "email", "token", "private@example.invalid");
    }
}
