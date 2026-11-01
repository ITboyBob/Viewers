package cn.colla.phaseone.auth;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import cn.colla.phaseone.identity.IdentityDtos.*;

@RestController
@RequestMapping("/api/v1/auth/sessions")
public class AuthController {
    private final SessionService sessions;
    public AuthController(SessionService sessions) { this.sessions = sessions; }
    @PostMapping @ResponseStatus(HttpStatus.CREATED)
    public Data<IssuedSession> login(@Valid @RequestBody Credentials input, HttpServletRequest request) {
        var issued = sessions.login(input);
        request.setAttribute("colla.actor", issued.user().uid()); request.setAttribute("colla.team", issued.default_team_id());
        return new Data<>(issued);
    }
    @GetMapping("/current") public Data<SessionContext> current(@AuthenticationPrincipal SessionPrincipal principal) { return new Data<>(sessions.context(principal)); }
    @DeleteMapping("/current") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void logout(HttpServletRequest request) { request.setAttribute("colla.actor", sessions.revoke(BearerSessionFilter.token(request))); }
}
