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
    public NotificationController(InvitationRepository invitations) { this.invitations = invitations; }
    @GetMapping
    public Page<InvitationView> list(@AuthenticationPrincipal SessionPrincipal principal,
                                    @RequestParam MultiValueMap<String, String> query) {
        return invitations.notifications(principal.uid(), PageQuery.parse(query));
    }
}
