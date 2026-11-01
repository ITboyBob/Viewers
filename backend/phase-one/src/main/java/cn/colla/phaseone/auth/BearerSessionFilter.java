package cn.colla.phaseone.auth;

import java.io.IOException;
import java.util.List;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;
import cn.colla.phaseone.shared.ApiException;
import cn.colla.phaseone.shared.ApiExceptionHandler;

public class BearerSessionFilter extends OncePerRequestFilter {
    private final SessionService sessions;
    private final ApiExceptionHandler errors;
    public BearerSessionFilter(SessionService sessions, ApiExceptionHandler errors) { this.sessions = sessions; this.errors = errors; }
    public static String token(HttpServletRequest request) {
        String header = request.getHeader("Authorization");
        if (header == null || !header.matches("(?i:Bearer) [A-Za-z0-9_-]{43}")) return null;
        return header.substring(7);
    }
    @Override protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI().substring(request.getContextPath().length());
        return (request.getMethod().equals("POST") && (path.equals("/api/v1/users") || path.equals("/api/v1/auth/sessions")))
            || (request.getMethod().equals("GET") && path.equals("/actuator/health"))
            || (request.getMethod().equals("DELETE") && path.equals("/api/v1/auth/sessions/current"));
    }
    @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {
        String token = token(request);
        if (token != null) {
            try {
                var principal = sessions.resolve(token);
                SecurityContextHolder.getContext().setAuthentication(UsernamePasswordAuthenticationToken.authenticated(principal, null, List.of()));
                request.setAttribute("colla.actor", principal.uid());
            } catch (ApiException invalid) { errors.write(response, invalid); return; }
            catch (Exception unavailable) {
                errors.write(response, new ApiException(org.springframework.http.HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "服务暂时不可用")); return;
            }
        }
        chain.doFilter(request, response);
    }
}
