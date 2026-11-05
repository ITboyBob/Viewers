package cn.colla.phaseone.collaboration;

import cn.colla.phaseone.dashboard.DashboardTargetResolver;
import cn.colla.phaseone.identity.IdentityRepository;
import cn.colla.phaseone.shared.ApiException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/** 任务级资格只用于指定任务；不授予任何团队级列表、管理或所有者权限。 */
@Service
public class TaskAccessPolicy {
  public record Access(
      String taskId,
      String teamId,
      String ownerUid,
      boolean canEdit,
      String collaborationPermission,
      boolean canAddSegmentation) {}

  private final JdbcTemplate jdbc;
  private final IdentityRepository identities;

  public TaskAccessPolicy(JdbcTemplate jdbc, IdentityRepository identities) {
    this.jdbc = jdbc;
    this.identities = identities;
  }

  public Access read(String uid, String taskId) {
    identities
        .byUid(uid)
        .filter(a -> "active".equals(a.status()))
        .orElseThrow(ApiException::unauthorized);
    String id = DashboardTargetResolver.uuid(taskId);
    var task =
        jdbc
            .query(
                "SELECT team_id,assignee_uid FROM task_record WHERE task_id=?",
                (r, n) -> new String[] {r.getString(1), r.getString(2)},
                id)
            .stream()
            .findFirst()
            .orElseThrow(TaskAccessPolicy::missing);
    boolean member =
        jdbc.queryForObject(
                "SELECT COUNT(*) FROM team_member WHERE team_id=? AND uid=?",
                Integer.class,
                task[0],
                uid)
            > 0;
    String permission =
        jdbc
            .query(
                "SELECT permission FROM workspace_collaboration_grant WHERE task_id=? AND uid=?",
                (r, n) -> r.getString(1),
                id,
                uid)
            .stream()
            .findFirst()
            .orElse(null);
    if (!member && permission == null) throw missing();
    boolean editable =
        jdbc.queryForObject(
                "SELECT COUNT(*) FROM task_read_only WHERE task_id=? AND uid=?",
                Integer.class,
                id,
                uid)
            == 0;
    // 团队原有路径不增加权限覆盖；独立协作者的 view 仅限制新增分割。
    return new Access(
        id,
        task[0],
        task[1],
        editable,
        permission,
        editable && (member || !"view".equals(permission)));
  }

  public static ApiException missing() {
    return new ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", "资源不存在");
  }
}
