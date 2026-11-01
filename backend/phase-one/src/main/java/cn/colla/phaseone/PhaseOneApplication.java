package cn.colla.phaseone;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication(exclude = org.springframework.boot.autoconfigure.security.servlet.UserDetailsServiceAutoConfiguration.class)
public class PhaseOneApplication {
    public static void main(String[] args) {
        SpringApplication.run(PhaseOneApplication.class, args);
    }
}
