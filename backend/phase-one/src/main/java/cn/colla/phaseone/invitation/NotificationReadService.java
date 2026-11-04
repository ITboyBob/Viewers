package cn.colla.phaseone.invitation;

import cn.colla.phaseone.identity.IdentityRepository;
import cn.colla.phaseone.shared.ApiException;
import java.time.Clock;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** 已读是收件人独立状态，不能由邀请decision推导。 */
@Service
public class NotificationReadService {
  private final JdbcTemplate jdbc;
  private final Clock clock;

  public NotificationReadService(JdbcTemplate jdbc, Clock clock) {
    this.jdbc = jdbc;
    this.clock = clock;
  }

  public record Unread(long unread_count) {}

  public Unread count(String uid) {
    return new Unread(
        jdbc.queryForObject(
            "SELECT COUNT(*) FROM team_invitation WHERE invitee_uid=? AND read_at IS NULL",
            Long.class,
            uid));
  }

  @Transactional
  public Unread mark(String uid, List<String> ids) {
    if (ids == null
        || ids.size() > 1000
        || ids.stream()
            .anyMatch(
                x ->
                    x == null
                        || !x.matches(
                            "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}")))
      throw ApiException.validation();
    for (String id : new LinkedHashSet<>(ids)) {
      if (jdbc.queryForObject(
              "SELECT COUNT(*) FROM team_invitation WHERE invitation_id=? AND invitee_uid=?",
              Integer.class,
              id,
              uid)
          != 1) throw new ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", "通知不存在");
      jdbc.update(
          "UPDATE team_invitation SET read_at=COALESCE(read_at,?) WHERE invitation_id=? AND"
              + " invitee_uid=?",
          IdentityRepository.utc(clock.instant()),
          id,
          uid);
    }
    return count(uid);
  }
}
