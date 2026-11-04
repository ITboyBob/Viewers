package cn.colla.phaseone.invitation;

import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.*;
import cn.colla.phaseone.auth.SessionPrincipal;
import static cn.colla.phaseone.invitation.InvitationDtos.*;

@RestController
@RequestMapping("/api/v1/notifications/team-invitations")
public class NotificationController {
    private final InvitationRepository invitations;
    private final NotificationReadService reads;
    public NotificationController(InvitationRepository invitations, NotificationReadService reads) { this.invitations = invitations; this.reads=reads; }
    public record MarkRead(java.util.List<String> invitation_ids) {}
    @GetMapping("/unread-count") public cn.colla.phaseone.identity.IdentityDtos.Data<NotificationReadService.Unread> unread(@AuthenticationPrincipal SessionPrincipal principal) {
        return new cn.colla.phaseone.identity.IdentityDtos.Data<>(reads.count(principal.uid()));
    }
    @PostMapping("/read") public cn.colla.phaseone.identity.IdentityDtos.Data<NotificationReadService.Unread> read(@AuthenticationPrincipal SessionPrincipal principal, @RequestBody MarkRead input) {
        if (input==null) throw cn.colla.phaseone.shared.ApiException.validation();
        return new cn.colla.phaseone.identity.IdentityDtos.Data<>(reads.mark(principal.uid(),input.invitation_ids()));
    }
    @GetMapping
    public Page<InvitationView> list(@AuthenticationPrincipal SessionPrincipal principal,
                                    @RequestParam MultiValueMap<String, String> query) {
        return invitations.notifications(principal.uid(), PageQuery.parse(query));
    }
}
