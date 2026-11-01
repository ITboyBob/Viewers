package cn.colla.phaseone.shared;

import java.io.IOException;
import java.util.Map;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.MismatchedInputException;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class ApiExceptionHandler {
    private final ObjectMapper json;
    public ApiExceptionHandler(ObjectMapper json) { this.json = json; }
    public record ErrorDetail(String code, String message, Map<String, String> details) {}
    public record ErrorEnvelope(ErrorDetail error) {}
    private ErrorEnvelope envelope(ApiException error) {
        return new ErrorEnvelope(new ErrorDetail(error.code(), error.getMessage(),
            error.reason() == null ? Map.of() : Map.of("reason", error.reason())));
    }
    public void write(HttpServletResponse response, ApiException error) throws IOException {
        response.setStatus(error.status().value());
        response.setContentType("application/json"); response.setCharacterEncoding("UTF-8");
        json.writeValue(response.getOutputStream(), envelope(error));
    }
    @ExceptionHandler(ApiException.class)
    public ResponseEntity<ErrorEnvelope> api(ApiException error) { return ResponseEntity.status(error.status()).body(envelope(error)); }
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ErrorEnvelope> validation() { return api(ApiException.validation()); }
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ErrorEnvelope> malformed(HttpMessageNotReadableException error) {
        return api(error.getCause() instanceof MismatchedInputException ? ApiException.validation()
            : new ApiException(HttpStatus.BAD_REQUEST, "BAD_REQUEST", "请求 JSON 无法解析"));
    }
    @ExceptionHandler(org.springframework.web.servlet.resource.NoResourceFoundException.class)
    public ResponseEntity<ErrorEnvelope> notFound() {
        return api(new ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", "资源不存在"));
    }
    @ExceptionHandler(org.springframework.web.HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<ErrorEnvelope> methodNotAllowed() {
        return api(new ApiException(HttpStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED", "不支持该请求方法"));
    }
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorEnvelope> unknown(Exception error) {
        // 不输出异常对象：SQL 异常可能携带绑定参数、密码摘要或用户信息。
        return api(new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "服务暂时不可用"));
    }
}
