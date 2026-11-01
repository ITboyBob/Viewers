package cn.colla.phaseone.auth;

import java.time.Clock;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.security.web.context.SecurityContextHolderFilter;
import cn.colla.phaseone.shared.ApiException;
import cn.colla.phaseone.shared.ApiExceptionHandler;
import cn.colla.phaseone.shared.RequestAuditFilter;

@Configuration
public class SecurityConfig {
    @Bean public PasswordEncoder passwordEncoder() { return new BCryptPasswordEncoder(12); }
    @Bean public SecurityFilterChain securityFilterChain(HttpSecurity http, ApiExceptionHandler errors, SessionService sessions, Clock clock) throws Exception {
        return http.csrf(c -> c.disable()).formLogin(c -> c.disable()).httpBasic(c -> c.disable()).logout(c -> c.disable())
            .requestCache(c -> c.disable()).sessionManagement(c -> c.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .addFilterBefore(new RequestAuditFilter(clock), SecurityContextHolderFilter.class)
            .addFilterBefore(new BearerSessionFilter(sessions, errors), UsernamePasswordAuthenticationFilter.class)
            .exceptionHandling(c -> c.authenticationEntryPoint((request, response, error) -> errors.write(response, ApiException.unauthorized()))
                .accessDeniedHandler((request, response, error) -> errors.write(response, new ApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "没有权限执行该操作"))))
            .authorizeHttpRequests(c -> c.requestMatchers(HttpMethod.POST, "/api/v1/users", "/api/v1/auth/sessions").permitAll()
                .requestMatchers(HttpMethod.DELETE, "/api/v1/auth/sessions/current").permitAll()
                .requestMatchers(HttpMethod.GET, "/actuator/health").permitAll().anyRequest().authenticated()).build();
    }
}
