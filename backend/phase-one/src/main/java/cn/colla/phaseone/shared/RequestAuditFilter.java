package cn.colla.phaseone.shared;

import java.io.IOException;
import java.time.Clock;
import java.util.UUID;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.filter.OncePerRequestFilter;

public class RequestAuditFilter extends OncePerRequestFilter {
    private static final Logger AUDIT = LoggerFactory.getLogger("colla.audit");
    private final Clock clock;
    public RequestAuditFilter(Clock clock) { this.clock = clock; }
    @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {
        String id = UUID.randomUUID().toString(); response.setHeader("X-Request-ID", id);
        // 不记录任意 URI、查询、请求体或异常，避免凭证及患者信息进入审计。
        String path = request.getRequestURI().substring(request.getContextPath().length());
        String action = switch (path) {
            case "/api/v1/users" -> "registration";
            case "/api/v1/auth/sessions" -> "login";
            case "/api/v1/auth/sessions/current" -> request.getMethod().equals("DELETE") ? "logout" : "current";
            case "/actuator/health" -> "health";
            default -> "protected_request";
        };
        try { chain.doFilter(request, response); }
        finally {
            AUDIT.info("request_id={} uid={} target={} team_id={} action={} decision={} timestamp={} result={}",
                id, request.getAttribute("colla.actor"), request.getAttribute("colla.actor"), request.getAttribute("colla.team"),
                action, response.getStatus() < 400 ? "allow" : "deny", clock.instant(), response.getStatus());
        }
    }
}
