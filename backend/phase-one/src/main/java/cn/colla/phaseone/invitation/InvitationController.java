package cn.colla.phaseone.invitation;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import cn.colla.phaseone.auth.SessionPrincipal;
import cn.colla.phaseone.identity.IdentityDtos.Data;
import cn.colla.phaseone.shared.ApiException;
import static cn.colla.phaseone.invitation.InvitationDtos.*;

@RestController
@RequestMapping("/api/v1")
public class InvitationController {
    private final InvitationService invitations;
    public InvitationController(InvitationService invitations) { this.invitations = invitations; }
    @PostMapping("/invitations/{id}/accept")
    public Data<InvitationView> accept(@AuthenticationPrincipal SessionPrincipal principal, @PathVariable String id,
                                      @RequestBody(required = false) com.fasterxml.jackson.databind.JsonNode body, HttpServletRequest request) {
        return decision(principal, id, true, body, request);
    }
    @PostMapping("/invitations/{id}/reject")
    public Data<InvitationView> reject(@AuthenticationPrincipal SessionPrincipal principal, @PathVariable String id,
                                      @RequestBody(required = false) com.fasterxml.jackson.databind.JsonNode body, HttpServletRequest request) {
        return decision(principal, id, false, body, request);
    }
    private Data<InvitationView> decision(SessionPrincipal principal, String id, boolean accept,
                                          com.fasterxml.jackson.databind.JsonNode body, HttpServletRequest request) {
        if (body != null || !request.getParameterMap().isEmpty()) throw ApiException.validation();
        var result = invitations.decide(principal.uid(), id, accept);
        request.setAttribute("colla.team", result.team_id());
        return new Data<>(result);
    }
    @PostMapping("/teams/{teamId}/invitations") @ResponseStatus(HttpStatus.CREATED)
    public Data<InvitationView> send(@AuthenticationPrincipal SessionPrincipal principal, @PathVariable String teamId,
                                    @Valid @RequestBody SendInvitation input, HttpServletRequest request) {
        if (!request.getParameterMap().isEmpty()) throw ApiException.validation();
        var result = invitations.send(principal.uid(), teamId, input);
        request.setAttribute("colla.team", result.team_id());
        return new Data<>(result);
    }
}
