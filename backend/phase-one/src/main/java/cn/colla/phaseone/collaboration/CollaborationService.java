package cn.colla.phaseone.collaboration;

import static cn.colla.phaseone.collaboration.TaskAccessPolicy.missing;
import static cn.colla.phaseone.identity.IdentityRepository.utc;

import cn.colla.phaseone.identity.IdentityDtos.UserSummary;
import cn.colla.phaseone.identity.IdentityRepository;
import cn.colla.phaseone.invitation.InvitationDtos.PageQuery;
import cn.colla.phaseone.shared.ApiException;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.validation.constraints.*;
import java.time.*;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class CollaborationService {
  public record Send(
      @NotBlank @Size(max = 64) String username,
      @NotBlank @Pattern(regexp = "edit|view") String permission) {
    public Send {
      if (username != null) username = username.strip();
    }
  }

  public record Invitee(String uid, String username) {}

  public record Invitation(
      String invitation_id,
      String task_id,
      String task_title,
      UserSummary inviter,
      Invitee invitee,
      String invitee_uid,
      String permission,
      String decision,
      Instant created_at,
      Instant expires_at,
      Instant decided_at,
      Instant read_at) {}

  public record Meta(int page, int page_size, long total, Instant server_time) {}

  public record Page(List<Invitation> data, Meta meta) {}

  public record Accepted(Invitation invitation, String task_id, String mode_path) {}

  public record Unread(long unread_count) {}

  private final JdbcTemplate jdbc;
  private final IdentityRepository identities;
  private final TaskAccessPolicy access;
  private final Clock clock;
  private final ObjectMapper json;

  public CollaborationService(
      JdbcTemplate jdbc,
      IdentityRepository identities,
      TaskAccessPolicy access,
      Clock clock,
      ObjectMapper json) {
    this.jdbc = jdbc;
    this.identities = identities;
    this.access = access;
    this.clock = clock;
    this.json = json;
  }

  private void lock(String task) {
    if (jdbc.queryForList("SELECT task_id FROM task_record WHERE task_id=? FOR UPDATE", task)
        .isEmpty()) throw missing();
  }

  private String mode(String task) {
    var manifest =
        jdbc
            .query(
                "SELECT manifest FROM task_material WHERE task_id=?",
                (r, n) -> r.getString(1),
                task)
            .stream()
            .findFirst()
            .orElseThrow(TaskAccessPolicy::missing);
    try {
      String value = json.readTree(manifest).path("mode_path").asText();
      if (Set.of("segmentation/dicomlocal", "microscopy").contains(value)) return value;
    } catch (java.io.IOException invalid) {
      throw new IllegalStateException("工作台材料损坏", invalid);
    }
    throw missing();
  }

  private boolean granted(String task, String uid) {
    return jdbc.queryForObject(
            "SELECT COUNT(*) FROM workspace_collaboration_grant WHERE task_id=? AND uid=?",
            Integer.class,
            task,
            uid)
        > 0;
  }

  private TaskAccessPolicy.Access invitationAccess(String actor, String task) {
    try {
      return access.read(actor, task);
    } catch (ApiException failure) {
      // 不存在与无访问资格使用相同发送错误，不泄露工作台是否存在。
      if (failure.status() == HttpStatus.NOT_FOUND)
        throw new ApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "不能邀请当前工作台");
      throw failure;
    }
  }

  @Transactional
  public Invitation send(String actor, String rawTask, Send input) {
    String task = invitationAccess(actor, rawTask).taskId();
    lock(task);
    invitationAccess(actor, task);
    mode(task);
    var target =
        identities
            .byUsername(input.username())
            .filter(a -> "active".equals(a.status()) && !actor.equals(a.uid()))
            .orElseThrow(
                () ->
                    new ApiException(
                        HttpStatus.UNPROCESSABLE_ENTITY,
                        "VALIDATION_ERROR",
                        "无法邀请该用户",
                        "INVALID_INVITEE"));
    if (granted(task, target.uid())) throw conflict("ALREADY_COLLABORATOR");
    var now = clock.instant();
    if (jdbc.queryForObject(
            "SELECT COUNT(*) FROM workspace_collaboration_invitation WHERE task_id=? AND"
                + " inviter_uid=? AND invitee_uid=? AND expires_at>?",
            Integer.class,
            task,
            actor,
            target.uid(),
            utc(now))
        > 0) throw conflict("INVITATION_COOLDOWN");
    String id = UUID.randomUUID().toString();
    jdbc.update(
        "INSERT INTO"
            + " workspace_collaboration_invitation(invitation_id,task_id,inviter_uid,invitee_uid,permission,created_at,expires_at)"
            + " VALUES(?,?,?,?,?,?,?)",
        id,
        task,
        actor,
        target.uid(),
        input.permission(),
        utc(now),
        utc(now.plusSeconds(300)));
    return view(id);
  }

  @Transactional
  public Page sent(String actor, String rawTask, PageQuery page) {
    String task = access.read(actor, rawTask).taskId();
    var now = clock.instant();
    return page(
        "i.task_id=? AND i.inviter_uid=? AND i.expires_at>?",
        List.of(task, actor, utc(now)),
        page,
        now);
  }

  public Page notifications(String actor, PageQuery page) {
    return page("i.invitee_uid=?", List.of(actor), page, clock.instant());
  }

  public Unread unread(String actor) {
    return new Unread(
        jdbc.queryForObject(
            "SELECT COUNT(*) FROM workspace_collaboration_invitation WHERE invitee_uid=? AND"
                + " read_at IS NULL",
            Long.class,
            actor));
  }

  @Transactional
  public Unread markRead(String actor, List<String> ids) {
    if (ids == null || ids.size() > 1000) throw ApiException.validation();
    var unique = new LinkedHashSet<String>();
    for (var id : ids) unique.add(cn.colla.phaseone.dashboard.DashboardTargetResolver.uuid(id));
    for (var id : unique) {
      if (jdbc.queryForObject(
              "SELECT COUNT(*) FROM workspace_collaboration_invitation WHERE invitation_id=? AND"
                  + " invitee_uid=?",
              Integer.class,
              id,
              actor)
          != 1) throw missing();
      jdbc.update(
          "UPDATE workspace_collaboration_invitation SET read_at=COALESCE(read_at,?) WHERE"
              + " invitation_id=? AND invitee_uid=?",
          utc(clock.instant()),
          id,
          actor);
    }
    return unread(actor);
  }

  private Invitation visible(String actor, String id) {
    String canonical = cn.colla.phaseone.dashboard.DashboardTargetResolver.uuid(id);
    if (jdbc.queryForObject(
            "SELECT COUNT(*) FROM workspace_collaboration_invitation WHERE invitation_id=? AND"
                + " invitee_uid=?",
            Integer.class,
            canonical,
            actor)
        != 1) throw missing();
    return view(canonical);
  }

  @Transactional
  public Accepted accept(String actor, String id) {
    var initial = visible(actor, id);
    lock(initial.task_id());
    var invitation = visible(actor, id);
    String mode = mode(invitation.task_id());
    if ("accepted".equals(invitation.decision())) {
      // 成功接受的重放先于期限检查；授权不随邀请期限到达而消失。
      access.read(actor, invitation.task_id());
      return new Accepted(invitation, invitation.task_id(), mode);
    }
    if (!"pending".equals(invitation.decision())) throw conflict("DECISION_CONFLICT");
    if (granted(invitation.task_id(), actor)) throw conflict("ALREADY_COLLABORATOR");
    var now = clock.instant();
    if (!now.isBefore(invitation.expires_at())) throw conflict("INVITATION_EXPIRED");
    jdbc.update(
        "INSERT INTO"
            + " workspace_collaboration_grant(task_id,uid,permission,invitation_id,accepted_at)"
            + " VALUES(?,?,?,?,?)",
        invitation.task_id(),
        actor,
        invitation.permission(),
        invitation.invitation_id(),
        utc(now));
    decide(invitation.invitation_id(), "accepted", now);
    return new Accepted(view(invitation.invitation_id()), invitation.task_id(), mode);
  }

  @Transactional
  public Invitation reject(String actor, String id) {
    var initial = visible(actor, id);
    lock(initial.task_id());
    var invitation = visible(actor, id);
    if ("accepted".equals(invitation.decision())) throw conflict("DECISION_CONFLICT");
    if ("pending".equals(invitation.decision()))
      decide(invitation.invitation_id(), "rejected", clock.instant());
    return view(invitation.invitation_id());
  }

  private void decide(String id, String decision, Instant now) {
    jdbc.update(
        "UPDATE workspace_collaboration_invitation SET decision=?,decided_at=? WHERE"
            + " invitation_id=?",
        decision,
        utc(now),
        id);
  }

  private static ApiException conflict(String reason) {
    String message =
        switch (reason) {
          case "INVITATION_COOLDOWN" -> "原五分钟期限内已邀请该用户";
          case "ALREADY_COLLABORATOR" -> "该用户已接受此工作台邀请，不能重复邀请或变更权限";
          case "INVITATION_EXPIRED" -> "邀请已过期";
          default -> "邀请处理状态冲突";
        };
    return new ApiException(HttpStatus.CONFLICT, "CONFLICT", message, reason);
  }

  private static final String SELECT =
      "SELECT i.*,t.title,u.username AS sender_name,u.avatar_url AS sender_avatar,v.username AS"
          + " recipient_name FROM workspace_collaboration_invitation i JOIN task_record t ON"
          + " t.task_id=i.task_id JOIN app_user u ON u.uid=i.inviter_uid JOIN app_user v ON"
          + " v.uid=i.invitee_uid ";

  private Invitation map(java.sql.ResultSet r, int n) throws java.sql.SQLException {
    return new Invitation(
        r.getString("invitation_id"),
        r.getString("task_id"),
        r.getString("title"),
        new UserSummary(
            r.getString("inviter_uid"), r.getString("sender_name"), r.getString("sender_avatar")),
        new Invitee(r.getString("invitee_uid"), r.getString("recipient_name")),
        r.getString("invitee_uid"),
        r.getString("permission"),
        r.getString("decision"),
        instant(r, "created_at"),
        instant(r, "expires_at"),
        instant(r, "decided_at"),
        instant(r, "read_at"));
  }

  private Instant instant(java.sql.ResultSet r, String field) throws java.sql.SQLException {
    var value = r.getObject(field, OffsetDateTime.class);
    return value == null ? null : value.toInstant();
  }

  private Invitation view(String id) {
    return jdbc.query(SELECT + "WHERE i.invitation_id=?", this::map, id).stream()
        .findFirst()
        .orElseThrow(TaskAccessPolicy::missing);
  }

  private Page page(String where, List<Object> args, PageQuery page, Instant now) {
    long total =
        jdbc.queryForObject(
            "SELECT COUNT(*) FROM workspace_collaboration_invitation i WHERE " + where,
            Long.class,
            args.toArray());
    var values = new ArrayList<>(args);
    values.add(page.size());
    values.add(page.offset());
    return new Page(
        jdbc.query(
            SELECT
                + "WHERE "
                + where
                + " ORDER BY i.created_at DESC,i.invitation_id DESC LIMIT ? OFFSET ?",
            this::map,
            values.toArray()),
        new Meta(page.page(), page.size(), total, now));
  }
}
