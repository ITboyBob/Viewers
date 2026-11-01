package cn.colla.phaseone.team;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.*;
import cn.colla.phaseone.auth.SessionPrincipal;
import static cn.colla.phaseone.invitation.InvitationDtos.*;

@RestController
@RequestMapping("/api/v1/teams/{teamId}/members")
public class TeamMemberController {
    private final TeamMemberQuery members;
    public TeamMemberController(TeamMemberQuery members) { this.members = members; }
    @GetMapping
    public Page<TeamMemberQuery.MemberView> list(@AuthenticationPrincipal SessionPrincipal principal, @PathVariable String teamId,
                                               @RequestParam MultiValueMap<String, String> query, HttpServletRequest request) {
        var result = members.list(principal.uid(), teamId, PageQuery.parse(query));
        request.setAttribute("colla.team", teamId);
        return result;
    }
}
