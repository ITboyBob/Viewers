package cn.colla.phaseone.invitation;

import java.time.Clock;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import cn.colla.phaseone.identity.IdentityRepository;
import cn.colla.phaseone.shared.ApiException;
import cn.colla.phaseone.team.TeamPolicy;
import static cn.colla.phaseone.invitation.InvitationDtos.*;

@Service
public class InvitationService {
    private final InvitationRepository invitations;
    private final IdentityRepository identities;
    private final TeamPolicy teams;
    private final TransactionTemplate transaction;
    private final Clock clock;
    public InvitationService(InvitationRepository invitations, IdentityRepository identities, TeamPolicy teams,
                             TransactionTemplate transaction, Clock clock) {
        this.invitations = invitations; this.identities = identities; this.teams = teams;
        this.transaction = transaction; this.clock = clock;
    }
    public InvitationView send(String actor, String teamId, SendInvitation input) {
        return transaction.execute(status -> {
            teams.requireMember(actor, teamId);
            invitations.lockTeam(teamId);
            teams.requireMember(actor, teamId);
            var recipient = identities.byUsername(input.username()).filter(user -> user.status().equals("active") && !actor.equals(user.uid()))
                .orElseThrow(() -> new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, "VALIDATION_ERROR", "无法邀请该用户", "INVALID_INVITEE"));
            if (invitations.isMember(teamId, recipient.uid())) throw conflict("ALREADY_MEMBER");
            var now = clock.instant();
            if (invitations.coolingDown(teamId, actor, recipient.uid(), now)) throw conflict("INVITATION_COOLDOWN");
            var id = UUID.randomUUID().toString();
            invitations.insert(id, teamId, actor, recipient.uid(), now);
            return invitations.view(id);
        });
    }
    public InvitationView decide(String actor, String id, boolean accept) {
        return transaction.execute(status -> {
            // 最小接收者过滤先定位团队；全域写操作严格保持 team → invitation 锁序。
            var teamId = invitations.visibleTeam(id, actor);
            invitations.lockTeam(teamId);
            var row = invitations.lockInvitation(id, actor);
            var now = clock.instant();
            if (row.invalidatedAt() != null || !now.isBefore(row.expiresAt())) throw conflict("INVITATION_EXPIRED");
            String decision = accept ? "accepted" : "rejected";
            if (!row.decision().equals("pending")) {
                if (!row.decision().equals(decision)) throw conflict("DECISION_CONFLICT");
                return invitations.view(id);
            }
            if (invitations.isMember(teamId, actor)) throw conflict("ALREADY_MEMBER");
            if (accept) {
                invitations.addAnnotator(teamId, actor, now);
                invitations.invalidateOthers(teamId, actor, id, now);
            }
            invitations.decide(id, decision, now);
            return invitations.view(id);
        });
    }
    public SentPage sent(String actor, String teamId, PageQuery page) {
        return transaction.execute(status -> {
            teams.requireMember(actor, teamId);
            invitations.lockTeam(teamId);
            teams.requireMember(actor, teamId);
            return invitations.sent(teamId, actor, page, clock.instant());
        });
    }
    private static ApiException conflict(String reason) { return new ApiException(HttpStatus.CONFLICT, "CONFLICT", "邀请操作发生冲突", reason); }
}
