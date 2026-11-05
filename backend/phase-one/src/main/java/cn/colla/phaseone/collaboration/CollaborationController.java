package cn.colla.phaseone.collaboration;

import static cn.colla.phaseone.collaboration.CollaborationService.*;

import cn.colla.phaseone.auth.SessionPrincipal;
import cn.colla.phaseone.identity.IdentityDtos.Data;
import cn.colla.phaseone.invitation.InvitationDtos.PageQuery;
import cn.colla.phaseone.shared.ApiException;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1")
public class CollaborationController {
  private final CollaborationService service;

  public CollaborationController(CollaborationService service) {
    this.service = service;
  }

  @PostMapping("/tasks/{taskId}/collaboration-invitations")
  @ResponseStatus(HttpStatus.CREATED)
  public Data<Invitation> send(
      @AuthenticationPrincipal SessionPrincipal p,
      @PathVariable String taskId,
      @Valid @RequestBody Send input) {
    return new Data<>(service.send(p.uid(), taskId, input));
  }

  @GetMapping("/tasks/{taskId}/collaboration-invitations/sent")
  public Page sent(
      @AuthenticationPrincipal SessionPrincipal p,
      @PathVariable String taskId,
      @RequestParam MultiValueMap<String, String> query) {
    return service.sent(p.uid(), taskId, PageQuery.parse(query));
  }

  @GetMapping("/notifications/collaboration-invitations")
  public Page notifications(
      @AuthenticationPrincipal SessionPrincipal p,
      @RequestParam MultiValueMap<String, String> query) {
    return service.notifications(p.uid(), PageQuery.parse(query));
  }

  @GetMapping("/notifications/collaboration-invitations/unread-count")
  public Data<Unread> unread(@AuthenticationPrincipal SessionPrincipal p) {
    return new Data<>(service.unread(p.uid()));
  }

  public record MarkRead(java.util.List<String> invitation_ids) {}

  @PostMapping("/notifications/collaboration-invitations/read")
  public Data<Unread> read(
      @AuthenticationPrincipal SessionPrincipal p, @RequestBody MarkRead input) {
    if (input == null) throw ApiException.validation();
    return new Data<>(service.markRead(p.uid(), input.invitation_ids()));
  }

  @PostMapping("/collaboration-invitations/{id}/accept")
  public Data<Accepted> accept(
      @AuthenticationPrincipal SessionPrincipal p, @PathVariable String id) {
    return new Data<>(service.accept(p.uid(), id));
  }

  @PostMapping("/collaboration-invitations/{id}/reject")
  public Data<Invitation> reject(
      @AuthenticationPrincipal SessionPrincipal p, @PathVariable String id) {
    return new Data<>(service.reject(p.uid(), id));
  }
}
