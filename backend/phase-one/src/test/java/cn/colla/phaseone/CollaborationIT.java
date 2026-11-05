package cn.colla.phaseone;

import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.ResultActions;

/** 所有协作资格均通过真实 HTTP 接口建立，不伪造团队成员或授权。 */
@org.springframework.boot.test.context.SpringBootTest(
    properties = "colla.database-name=collaboration_it")
class CollaborationIT extends InvitationTestSupport {
  @org.junit.jupiter.api.AfterEach
  void clearTasks() {
    for (String table : List.of("task_visit", "task_registration", "task_record"))
      jdbc.update("DELETE FROM " + table);
  }

  String task(JsonNode actor) throws Exception {
    return task(actor, new byte[] {1, 2, 3});
  }

  String task(JsonNode actor, byte[] bytes) throws Exception {
    String file = UUID.randomUUID().toString();
    var input =
        Map.of(
            "registration_key",
            UUID.randomUUID().toString(),
            "title",
            "协作工作台",
            "kind",
            "files",
            "mode_path",
            "segmentation/dicomlocal",
            "files",
            List.of(
                Map.of(
                    "file_id",
                    file,
                    "selection_index",
                    0,
                    "file_name",
                    "source.dcm",
                    "size",
                    bytes.length,
                    "study_uid",
                    "1.2.3",
                    "series_uid",
                    "1.2.3.4",
                    "sop_uid",
                    "1.2.3.4.5")));
    String id =
        data(http.perform(
                    post("/api/v1/teams/" + team(actor) + "/task-imports")
                        .header("Authorization", token(actor))
                        .contentType("application/json")
                        .content(json.writeValueAsBytes(input)))
                .andExpect(status().isOk()))
            .path("import_id")
            .asText();
    http.perform(
            put("/api/v1/task-imports/" + id + "/files/" + file)
                .header("Authorization", token(actor))
                .contentType("application/octet-stream")
                .content(bytes))
        .andExpect(status().isOk());
    return data(http.perform(
                post("/api/v1/task-imports/" + id + "/complete")
                    .header("Authorization", token(actor)))
            .andExpect(status().isOk()))
        .path("task_id")
        .asText();
  }

  ResultActions sendWork(JsonNode actor, String task, JsonNode target, String permission)
      throws Exception {
    return http.perform(
        post("/api/v1/tasks/" + task + "/collaboration-invitations")
            .header("Authorization", token(actor))
            .contentType("application/json")
            .content(
                json.writeValueAsBytes(
                    Map.of(
                        "username",
                        target.at("/user/username").asText(),
                        "permission",
                        permission))));
  }

  JsonNode invitation(JsonNode actor, String task, JsonNode target, String permission)
      throws Exception {
    return data(sendWork(actor, task, target, permission).andExpect(status().isCreated()));
  }

  ResultActions decideWork(JsonNode actor, String id, String decision) throws Exception {
    return http.perform(
        post("/api/v1/collaboration-invitations/" + id + "/" + decision)
            .header("Authorization", token(actor)));
  }

  ResultActions getWork(JsonNode actor, String path) throws Exception {
    return http.perform(get("/api/v1/" + path).header("Authorization", token(actor)));
  }

  ResultActions commit(JsonNode actor, String task, long revision, List<Map<String, Object>> masks)
      throws Exception {
    return commit(actor, task, revision, masks, "SEG");
  }

  ResultActions commit(
      JsonNode actor, String task, long revision, List<Map<String, Object>> masks, String type)
      throws Exception {
    String object = UUID.randomUUID().toString();
    byte[] header =
        json.writeValueAsBytes(
            Map.of(
                "version",
                1,
                "task_id",
                task,
                "type",
                type,
                "state",
                Map.of(
                    "taskId",
                    task,
                    "annotations",
                    List.of(),
                    "measurements",
                    List.of(),
                    "segmentations",
                    masks)));
    byte[] packet =
        ByteBuffer.allocate(4 + header.length)
            .order(ByteOrder.LITTLE_ENDIAN)
            .putInt(header.length)
            .put(header)
            .array();
    http.perform(
            put("/api/v1/tasks/" + task + "/result-files/" + object)
                .header("Authorization", token(actor))
                .contentType("application/octet-stream")
                .content(packet))
        .andExpect(status().isOk());
    return http.perform(
        post("/api/v1/tasks/" + task + "/results/commit")
            .header("Authorization", token(actor))
            .contentType("application/json")
            .content(
                json.writeValueAsBytes(
                    Map.of(
                        "operation_id",
                        UUID.randomUUID().toString(),
                        "base_revision",
                        revision,
                        "objects",
                        List.of(Map.of("object_id", object, "type", type))))));
  }

  void accept(JsonNode recipient, JsonNode invitation) throws Exception {
    decideWork(recipient, invitation.path("invitation_id").asText(), "accept")
        .andExpect(status().isOk());
  }

  @Test
  void independentGrantReadsAndSavesButCannotCreateSegmentation() throws Exception {
    var owner = register("work-owner");
    var viewer = register("work-viewer");
    var stranger = register("work-stranger");
    String task = task(owner), other = task(owner);
    commit(owner, task, 0, List.of(Map.of("segmentationId", "existing")))
        .andExpect(status().isOk());
    getWork(viewer, "tasks/" + task + "/materials").andExpect(status().isNotFound());
    var invitation = invitation(owner, task, viewer, "view");
    decideWork(stranger, invitation.path("invitation_id").asText(), "accept")
        .andExpect(status().isNotFound());
    accept(viewer, invitation);
    getWork(viewer, "tasks/" + task + "/materials")
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.data.access.can_edit").value(true))
        .andExpect(jsonPath("$.data.access.can_add_segmentation").value(false))
        .andExpect(jsonPath("$.data.access.collaboration_permission").value("view"))
        .andExpect(jsonPath("$.data.access.owner_uid").value(uid(owner)));
    assertThat(members(owner, viewer)).isZero();
    getWork(viewer, "tasks/" + other + "/materials").andExpect(status().isNotFound());
    getWork(viewer, "teams/" + team(owner) + "/members").andExpect(status().isNotFound());
    getWork(viewer, "tasks/" + task + "/members").andExpect(status().isOk());
    http.perform(post("/api/v1/tasks/" + task + "/visits").header("Authorization", token(viewer)))
        .andExpect(status().isNoContent());
    reason(
        commit(viewer, task, 1, List.of(Map.of("segmentationId", "new"))),
        403,
        "SEGMENTATION_CREATE_FORBIDDEN");
    getWork(viewer, "tasks/" + task + "/results").andExpect(jsonPath("$.data.revision").value(1));
    commit(
            viewer,
            task,
            1,
            List.of(
                Map.of(
                    "segmentationId",
                    "existing",
                    "segments",
                    Map.of("2", Map.of("label", "新增 segment")))))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.data.revision").value(2));
    commit(viewer, task, 1, List.of())
        .andExpect(status().isConflict())
        .andExpect(jsonPath("$.error.details.reason").value("REVISION_CONFLICT"));
    invitation(viewer, task, stranger, "edit");
  }

  @Test
  void editGrantPermitsCreationAndDoesNotChangeTeamOrCreator() throws Exception {
    var owner = register("edit-owner");
    var editor = register("edit-user");
    String task = task(owner);
    accept(editor, invitation(owner, task, editor, "edit"));
    getWork(editor, "tasks/" + task + "/results")
        .andExpect(jsonPath("$.data.access.can_add_segmentation").value(true));
    commit(editor, task, 0, List.of(Map.of("segmentationId", "created")))
        .andExpect(status().isOk());
    assertThat(members(owner, editor)).isZero();
    getWork(editor, "auth/sessions/current")
        .andExpect(jsonPath("$.data.selected_team_id").value(team(editor)));
  }

  @Test
  void senderDeadlinesSurviveDecisionsAndOtherSendersCannotChangeAcceptedPermission()
      throws Exception {
    var owner = register("deadline-owner");
    var recipient = register("deadline-user");
    var member = register("deadline-member");
    decide(member, invite(owner, member).path("invitation_id").asText(), "accept")
        .andExpect(status().isOk());
    String task = task(owner);
    var first = invitation(owner, task, recipient, "view");
    var second = invitation(member, task, recipient, "edit");
    reason(sendWork(owner, task, recipient, "edit"), 409, "INVITATION_COOLDOWN");
    accept(recipient, first);
    clock.set(START.plus(Duration.ofMinutes(6)));
    accept(recipient, first);
    reason(
        decideWork(recipient, second.path("invitation_id").asText(), "accept"),
        409,
        "ALREADY_COLLABORATOR");
    reason(sendWork(member, task, recipient, "edit"), 409, "ALREADY_COLLABORATOR");
    reason(
        decideWork(recipient, first.path("invitation_id").asText(), "reject"),
        409,
        "DECISION_CONFLICT");
    getWork(recipient, "tasks/" + task + "/materials")
        .andExpect(jsonPath("$.data.access.collaboration_permission").value("view"));
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM workspace_collaboration_grant WHERE task_id=?",
                Integer.class,
                task))
        .isEqualTo(1);
  }

  @Test
  void rejectedDeadlineAndExactExpiryAreEnforcedWithoutGrant() throws Exception {
    var owner = register("expiry-owner");
    var recipient = register("expiry-user");
    String task = task(owner);
    var first = invitation(owner, task, recipient, "view");
    decideWork(recipient, first.path("invitation_id").asText(), "reject")
        .andExpect(status().isOk());
    getWork(owner, "tasks/" + task + "/collaboration-invitations/sent")
        .andExpect(jsonPath("$.meta.total").value(1))
        .andExpect(jsonPath("$.meta.server_time").exists());
    reason(sendWork(owner, task, recipient, "edit"), 409, "INVITATION_COOLDOWN");
    reason(
        decideWork(recipient, first.path("invitation_id").asText(), "accept"),
        409,
        "DECISION_CONFLICT");
    clock.set(START.plusSeconds(300));
    var second = invitation(owner, task, recipient, "edit");
    clock.set(START.plusSeconds(600));
    reason(
        decideWork(recipient, second.path("invitation_id").asText(), "accept"),
        409,
        "INVITATION_EXPIRED");
    getWork(recipient, "tasks/" + task + "/materials").andExpect(status().isNotFound());
  }

  @Test
  void notificationReadIsRecipientScopedAndIndependentOfDecision() throws Exception {
    var owner = register("read-owner");
    var recipient = register("read-user");
    var stranger = register("read-stranger");
    String task = task(owner);
    String id = invitation(owner, task, recipient, "view").path("invitation_id").asText();
    getWork(stranger, "notifications/collaboration-invitations")
        .andExpect(jsonPath("$.meta.total").value(0));
    getWork(recipient, "notifications/collaboration-invitations/unread-count")
        .andExpect(jsonPath("$.data.unread_count").value(1));
    for (int i = 0; i < 2; i++)
      http.perform(
              post("/api/v1/notifications/collaboration-invitations/read")
                  .header("Authorization", token(recipient))
                  .contentType("application/json")
                  .content(json.writeValueAsBytes(Map.of("invitation_ids", List.of(id)))))
          .andExpect(status().isOk())
          .andExpect(jsonPath("$.data.unread_count").value(0));
    getWork(recipient, "notifications/collaboration-invitations")
        .andExpect(jsonPath("$.data[0].decision").value("pending"))
        .andExpect(jsonPath("$.data[0].task_title").value("协作工作台"));
    http.perform(
            post("/api/v1/notifications/collaboration-invitations/read")
                .header("Authorization", token(stranger))
                .contentType("application/json")
                .content(json.writeValueAsBytes(Map.of("invitation_ids", List.of(id)))))
        .andExpect(status().isNotFound());
  }

  @Test
  void invalidRecipientsPermissionsAndUnknownFieldsNeverCreateInvitations() throws Exception {
    var owner = register("invalid-owner");
    var recipient = register("invalid-user");
    String task = task(owner);
    sendWork(owner, task, owner, "edit").andExpect(status().isUnprocessableEntity());
    sendWork(owner, task, recipient, "admin").andExpect(status().isUnprocessableEntity());
    sendWork(recipient, task, owner, "edit").andExpect(status().isForbidden());
    for (String body :
        List.of(
            "{\"username\":\"missing\",\"permission\":\"view\"}",
            "{\"username\":\"invalid-user\",\"permission\":\"edit\",\"inviter_uid\":\"fake\"}"))
      http.perform(
              post("/api/v1/tasks/" + task + "/collaboration-invitations")
                  .header("Authorization", token(owner))
                  .contentType("application/json")
                  .content(body))
          .andExpect(status().isUnprocessableEntity());
    getWork(recipient, "notifications/collaboration-invitations/unread-count")
        .andExpect(jsonPath("$.data.unread_count").value(0));
  }

  @Test
  void concurrentSendAndAcceptHaveOneEffect() throws Exception {
    var owner = register("parallel-owner");
    var recipient = register("parallel-user");
    String task = task(owner);
    var sent =
        concurrent(
            6,
            i ->
                () ->
                    sendWork(owner, task, recipient, "view").andReturn().getResponse().getStatus());
    assertThat(sent.stream().filter(s -> s == 201).count()).isEqualTo(1);
    assertThat(sent).allMatch(s -> s == 201 || s == 409);
    String id =
        json.readTree(
                getWork(recipient, "notifications/collaboration-invitations")
                    .andReturn()
                    .getResponse()
                    .getContentAsString())
            .at("/data/0/invitation_id")
            .asText();
    assertThat(
            concurrent(
                6,
                i ->
                    () ->
                        decideWork(recipient, id, "accept").andReturn().getResponse().getStatus()))
        .containsOnly(200);
    assertThat(
            jdbc.queryForObject(
                "SELECT COUNT(*) FROM workspace_collaboration_grant WHERE task_id=?",
                Integer.class,
                task))
        .isEqualTo(1);
  }

  byte[] sourceDicom(String sopClass) throws Exception {
    var out = new java.io.ByteArrayOutputStream();
    out.write(new byte[128]);
    out.write("DICM".getBytes(StandardCharsets.US_ASCII));
    uidElement(out, 0x00020002, sopClass);
    uidElement(out, 0x00020003, "1.2.3.4.5");
    uidElement(out, 0x00020010, "1.2.840.10008.1.2.1");
    uidElement(out, 0x00080016, sopClass);
    uidElement(out, 0x00080018, "1.2.3.4.5");
    uidElement(out, 0x0020000d, "1.2.3");
    uidElement(out, 0x0020000e, "1.2.3.4");
    return out.toByteArray();
  }

  void uidElement(java.io.ByteArrayOutputStream out, int tag, String value) throws Exception {
    byte[] text = value.getBytes(StandardCharsets.US_ASCII);
    int length = (text.length + 1) / 2 * 2;
    out.write(
        ByteBuffer.allocate(8)
            .order(ByteOrder.LITTLE_ENDIAN)
            .putShort((short) (tag >>> 16))
            .putShort((short) tag)
            .put((byte) 'U')
            .put((byte) 'I')
            .putShort((short) length)
            .array());
    out.write(text);
    if (length > text.length) out.write(0);
  }

  @Test
  void trustedSourceSegAndRtIdentitiesSurviveChangingRuntimeAndObjectIds() throws Exception {
    var owner = register("source-owner");
    var viewer = register("source-viewer");
    for (String sop :
        List.of(
            "1.2.840.10008.5.1.4.1.1.66.4",
            "1.2.840.10008.5.1.4.1.1.66.7",
            "1.2.840.10008.5.1.4.1.1.481.3")) {
      String task = task(owner, sourceDicom(sop));
      accept(viewer, invitation(owner, task, viewer, "view"));
      String entity = "dicom:1.2.3/1.2.3.4/1.2.3.4.5";
      commit(
              viewer,
              task,
              0,
              List.of(Map.of("segmentationId", "runtime-first", "entity_id", entity)))
          .andExpect(status().isOk());
      commit(
              viewer,
              task,
              1,
              List.of(
                  Map.of(
                      "segmentationId",
                      "runtime-reloaded",
                      "entity_id",
                      entity,
                      "segments",
                      Map.of("3", Map.of("label", "既有实体新增 segment")))))
          .andExpect(status().isOk());
      commit(
              viewer,
              task,
              2,
              List.of(
                  Map.of("segmentationId", "duplicate-a", "entity_id", entity),
                  Map.of("segmentationId", "duplicate-b", "entity_id", entity)))
          .andExpect(status().isUnprocessableEntity());
      reason(
          commit(
              viewer,
              task,
              2,
              List.of(Map.of("segmentationId", "forged", "entity_id", "dicom:1/2/3"))),
          403,
          "SEGMENTATION_CREATE_FORBIDDEN");
      getWork(viewer, "tasks/" + task + "/results").andExpect(jsonPath("$.data.revision").value(2));
    }
  }

  @Test
  void otherPacketTypesCannotHideNewEntitiesAndConcurrentInvitationsCannotChangeGrant()
      throws Exception {
    var owner = register("typed-owner");
    var recipient = register("typed-user");
    var member = register("typed-member");
    decide(member, invite(owner, member).path("invitation_id").asText(), "accept")
        .andExpect(status().isOk());
    String task = task(owner);
    var one = invitation(owner, task, recipient, "view");
    var two = invitation(member, task, recipient, "view");
    var decisions =
        concurrent(
            2,
            i ->
                () ->
                    decideWork(
                            recipient,
                            (i == 0 ? one : two).path("invitation_id").asText(),
                            "accept")
                        .andReturn()
                        .getResponse()
                        .getStatus());
    assertThat(decisions).containsExactlyInAnyOrder(200, 409);
    reason(
        commit(recipient, task, 0, List.of(Map.of("segmentationId", "hidden")), "SR"),
        403,
        "SEGMENTATION_CREATE_FORBIDDEN");
    getWork(recipient, "tasks/" + task + "/results")
        .andExpect(jsonPath("$.data.revision").value(0));
    var ids = List.of(one.path("invitation_id").asText(), UUID.randomUUID().toString());
    http.perform(
            post("/api/v1/notifications/collaboration-invitations/read")
                .header("Authorization", token(recipient))
                .contentType("application/json")
                .content(json.writeValueAsBytes(Map.of("invitation_ids", ids))))
        .andExpect(status().isNotFound());
    getWork(recipient, "notifications/collaboration-invitations/unread-count")
        .andExpect(jsonPath("$.data.unread_count").value(2));
  }
}
