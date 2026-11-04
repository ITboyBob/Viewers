package cn.colla.phaseone.storage;

import static cn.colla.phaseone.storage.TaskStorageService.*;

import cn.colla.phaseone.auth.SessionPrincipal;
import cn.colla.phaseone.identity.IdentityDtos.Data;
import cn.colla.phaseone.task.TaskDtos.Task;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.file.Path;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1")
public class TaskStorageController {
  private final TaskStorageService storage;

  public TaskStorageController(TaskStorageService storage) {
    this.storage = storage;
  }

  @PostMapping("/teams/{teamId}/task-imports")
  public Data<ImportView> start(
      @AuthenticationPrincipal SessionPrincipal p,
      @PathVariable String teamId,
      @RequestBody StartImport input) {
    return new Data<>(storage.start(p.uid(), teamId, input));
  }

  @PutMapping("/task-imports/{id}/files/{file}")
  public Data<Boolean> source(
      @AuthenticationPrincipal SessionPrincipal p,
      @PathVariable String id,
      @PathVariable String file,
      HttpServletRequest request)
      throws IOException {
    storage.uploadSource(p.uid(), id, file, request.getInputStream());
    return new Data<>(true);
  }

  @PostMapping("/task-imports/{id}/complete")
  public Data<Task> complete(@AuthenticationPrincipal SessionPrincipal p, @PathVariable String id) {
    return new Data<>(storage.complete(p.uid(), id));
  }

  @GetMapping("/tasks/{id}/materials")
  public Data<Materials> materials(
      @AuthenticationPrincipal SessionPrincipal p, @PathVariable String id) {
    return new Data<>(storage.materials(p.uid(), id));
  }

  @GetMapping("/tasks/{id}/files/{file}")
  public ResponseEntity<FileSystemResource> file(
      @AuthenticationPrincipal SessionPrincipal p,
      @PathVariable String id,
      @PathVariable String file) {
    return binary(storage.source(p.uid(), id, file));
  }

  @GetMapping("/tasks/{id}/results")
  public Data<Results> results(
      @AuthenticationPrincipal SessionPrincipal p, @PathVariable String id) {
    return new Data<>(storage.results(p.uid(), id));
  }

  @PutMapping("/tasks/{id}/result-files/{object}")
  public Data<Boolean> upload(
      @AuthenticationPrincipal SessionPrincipal p,
      @PathVariable String id,
      @PathVariable String object,
      HttpServletRequest request)
      throws IOException {
    storage.uploadResult(p.uid(), id, object, request.getInputStream());
    return new Data<>(true);
  }

  @GetMapping("/tasks/{id}/result-files/{object}")
  public ResponseEntity<FileSystemResource> result(
      @AuthenticationPrincipal SessionPrincipal p,
      @PathVariable String id,
      @PathVariable String object) {
    return binary(storage.resultFile(p.uid(), id, object));
  }

  @PostMapping("/tasks/{id}/results/commit")
  public Data<Results> commit(
      @AuthenticationPrincipal SessionPrincipal p,
      @PathVariable String id,
      @RequestBody Commit input) {
    return new Data<>(storage.commit(p.uid(), id, input));
  }

  private ResponseEntity<FileSystemResource> binary(Path path) {
    return ResponseEntity.ok()
        .contentType(MediaType.APPLICATION_OCTET_STREAM)
        .cacheControl(CacheControl.noStore())
        .header("X-Content-Type-Options", "nosniff")
        .body(new FileSystemResource(path));
  }
}
