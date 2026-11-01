package cn.colla.phaseone.auth;

import java.security.Principal;
import java.time.Instant;

public record SessionPrincipal(String uid, Instant expiresAt) implements Principal {
    @Override public String getName() { return uid; }
}
