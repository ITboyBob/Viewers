package cn.colla.phaseone.shared;

import org.springframework.http.HttpStatus;

public class ApiException extends RuntimeException {
    private final HttpStatus status;
    private final String code;
    private final String reason;

    public ApiException(HttpStatus status, String code, String message) { this(status, code, message, null); }
    public ApiException(HttpStatus status, String code, String message, String reason) {
        super(message); this.status = status; this.code = code; this.reason = reason;
    }
    public HttpStatus status() { return status; }
    public String code() { return code; }
    public String reason() { return reason; }
    public static ApiException unauthorized() {
        return new ApiException(HttpStatus.UNAUTHORIZED, "UNAUTHORIZED", "认证信息无效或已失效");
    }
    public static ApiException validation() {
        return new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, "VALIDATION_ERROR", "请求字段不符合要求");
    }
}
