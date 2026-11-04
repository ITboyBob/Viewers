package cn.colla.phaseone.identity;

import java.time.Instant;
import java.util.List;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Size;

public final class IdentityDtos {
    private IdentityDtos() {}
    public record Credentials(@NotBlank @Size(max = 64) String username, @NotEmpty String password) {
        public Credentials { if (username != null) username = username.strip(); }
        @Override public String toString() { return "Credentials[已隐藏]"; }
    }
    public record UserSummary(String uid, String username, String avatar_url) {}
    public record TeamMembership(String team_id, String name, String owner_uid, String role) {}
    public record SessionContext(UserSummary user, Instant expires_at, String default_team_id, List<TeamMembership> memberships, String selected_team_id) {}
    public record IssuedSession(String token, UserSummary user, Instant expires_at, String default_team_id, List<TeamMembership> memberships, String selected_team_id) {
        public IssuedSession(String token, SessionContext context) { this(token, context.user(), context.expires_at(), context.default_team_id(), context.memberships(), context.selected_team_id()); }
        @Override public String toString() { return "IssuedSession[已隐藏]"; }
    }
    public record Data<T>(T data) {}
}
