package cn.colla.phaseone.invitation;

import java.time.Instant;
import java.util.List;
import java.util.Set;
import org.springframework.util.MultiValueMap;
import cn.colla.phaseone.shared.ApiException;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import cn.colla.phaseone.identity.IdentityDtos.UserSummary;

public final class InvitationDtos {
    private InvitationDtos() {}
    public record SendInvitation(@NotBlank @Size(max = 64) String username) {
        public SendInvitation { if (username != null) username = username.strip(); }
    }
    public record Meta(int page, int page_size, long total) {}
    public record Page<T>(List<T> data, Meta meta) {}
    public record PageQuery(int page, int size) {
        public long offset() { return ((long) page - 1) * size; }
        public Meta meta(long total) { return new Meta(page, size, total); }
        public static PageQuery parse(MultiValueMap<String, String> query) {
            if (!Set.of("page", "page_size").containsAll(query.keySet())) throw ApiException.validation();
            int page = positive(query, "page", 1);
            int size = positive(query, "page_size", 20);
            if (size > 100) throw ApiException.validation();
            return new PageQuery(page, size);
        }
        private static int positive(MultiValueMap<String, String> query, String key, int fallback) {
            var values = query.get(key);
            if (values == null) return fallback;
            if (values.size() != 1 || values.getFirst() == null || !values.getFirst().matches("[1-9][0-9]*")) throw ApiException.validation();
            try { return Integer.parseInt(values.getFirst()); }
            catch (NumberFormatException invalid) { throw ApiException.validation(); }
        }
    }
    public record InvitationView(String invitation_id, String team_id, String team_name,
        UserSummary inviter, String invitee_uid, Instant created_at, Instant expires_at,
        String decision, Instant decided_at) {}
}
