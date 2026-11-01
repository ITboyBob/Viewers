package cn.colla.phaseone.identity;

import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import cn.colla.phaseone.identity.IdentityDtos.*;

@RestController
@RequestMapping("/api/v1/users")
public class RegistrationController {
    private final RegistrationService registration;
    public RegistrationController(RegistrationService registration) { this.registration = registration; }
    @PostMapping @ResponseStatus(HttpStatus.CREATED)
    public Data<IssuedSession> register(@Valid @RequestBody Credentials input, jakarta.servlet.http.HttpServletRequest request) {
        var issued = registration.register(input);
        request.setAttribute("colla.actor", issued.user().uid()); request.setAttribute("colla.team", issued.default_team_id());
        return new Data<>(issued);
    }
}
