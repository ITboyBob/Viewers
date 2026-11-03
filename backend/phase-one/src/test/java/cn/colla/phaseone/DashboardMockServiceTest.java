package cn.colla.phaseone;

import cn.colla.phaseone.dashboard.DashboardDtos.*;
import cn.colla.phaseone.dashboard.DashboardMockFixtures;
import cn.colla.phaseone.dashboard.DashboardMockFixtures.Fixture;
import cn.colla.phaseone.dashboard.DashboardMockService;
import cn.colla.phaseone.dashboard.DashboardTargetResolver;
import cn.colla.phaseone.dashboard.DashboardTargetResolver.Viewer;
import cn.colla.phaseone.shared.ApiException;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.HttpStatus;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class DashboardMockServiceTest {
    private final Viewer alice = new Viewer("11111111-1111-4111-8111-111111111111", "演示甲", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    private final Viewer bob = new Viewer("22222222-2222-4222-8222-222222222222", "演示乙", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    private DashboardTargetResolver targets;
    private DashboardMockFixtures fixtures;
    private DashboardMockService service;

    @BeforeEach void prepare() {
        targets = mock(DashboardTargetResolver.class);
        fixtures = new DashboardMockFixtures();
        service = new DashboardMockService(targets, fixtures);
        when(targets.viewer(alice.uid())).thenReturn(alice);
        when(targets.viewer(bob.uid())).thenReturn(bob);
        when(targets.ownedTeam(alice.uid(), alice.ownedTeamId())).thenReturn(alice);
        when(targets.ownedTeam(bob.uid(), bob.ownedTeamId())).thenReturn(bob);
    }

    @Test void stableNamespaceIdsAndTimesSurviveProviderRecreation() {
        var before = fixtures.forViewer(alice);
        assertThat(new DashboardMockFixtures().forViewer(alice)).isEqualTo(before);
        assertThat(service.teamTasks(alice.uid(), alice.ownedTeamId()))
            .isEqualTo(service.teamTasks(alice.uid(), alice.ownedTeamId()));
        assertThat(service.recentTasks(alice.uid())).isEqualTo(service.recentTasks(alice.uid()));
        for (var task : before.teamTasks()) assertThat(UUID.fromString(task.task_id()).version()).isEqualTo(3);
    }

    @Test void privateTaskFixturesNeverCrossAccounts() {
        var a = fixtures.forViewer(alice);
        var b = fixtures.forViewer(bob);
        assertThat(a.teamTasks()).extracting(TeamTaskCard::task_id)
            .doesNotContainAnyElementsOf(b.teamTasks().stream().map(TeamTaskCard::task_id).toList());
    }

    @Test void sampleTaskStillRequiresExistingVisibleRealTask() {
        var task = service.recentTasks(alice.uid()).items().getFirst();
        when(targets.requireVisibleRealTask(alice.uid(), task.task_id()))
            .thenThrow(new ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", "资源不存在"));
        assertThatThrownBy(() -> service.taskMembers(alice.uid(), task.task_id()))
            .isInstanceOf(ApiException.class);
        verify(targets).requireVisibleRealTask(alice.uid(), task.task_id());
    }

    @Test void repeatedTeamCardsAreDeduplicatedWithConsistentTotal() {
        var base = fixtures.forViewer(alice);
        var provider = mock(DashboardMockFixtures.class);
        when(provider.forViewer(alice)).thenReturn(new Fixture(List.of(base.teamTasks().getFirst(), base.teamTasks().getFirst(), base.teamTasks().getLast()),
            base.recentTasks()));
        var result = new DashboardMockService(targets, provider).teamTasks(alice.uid(), alice.ownedTeamId());
        assertThat(result.mock()).isTrue();
        assertThat(result.items()).containsExactlyElementsOf(base.teamTasks());
        assertThat(result.total()).isEqualTo(2);
    }

    @Test void repeatedRecentKeepsLatestAndSortsTiesByTaskIdNotInputOrder() {
        var a = recent("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "2026-01-02T00:00:00Z");
        var b = recent("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "2026-01-02T00:00:00Z");
        var oldA = recent(a.task_id(), "2020-01-01T00:00:00Z");
        var oldest = recent("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "2019-01-01T00:00:00Z");
        var provider = mock(DashboardMockFixtures.class);
        when(provider.forViewer(alice)).thenReturn(new Fixture(List.of(), List.of(oldA, b, oldest, a, b)));
        var result = new DashboardMockService(targets, provider).recentTasks(alice.uid());
        assertThat(result.items()).containsExactly(a, b, oldest);
        assertThat(result.total()).isEqualTo(3);
        assertThat(result.mock()).isTrue();
    }

    @Test void emptyProviderIsValidButProviderFailureCannotBecomeEmptySuccess() {
        var provider = mock(DashboardMockFixtures.class);
        when(provider.forViewer(alice)).thenReturn(new Fixture(List.of(), List.of()));
        var custom = new DashboardMockService(targets, provider);
        assertThat(custom.teamTasks(alice.uid(), alice.ownedTeamId()).total()).isZero();
        assertThat(custom.recentTasks(alice.uid()).items()).isEmpty();
        when(provider.forViewer(alice)).thenThrow(new IllegalStateException("演示提供器不可用"));
        assertThatThrownBy(() -> custom.recentTasks(alice.uid())).isInstanceOf(IllegalStateException.class);
    }

    @Test void unknownTaskCannotFallbackWithoutExistingVisibleRealTarget() {
        String unknown = UUID.randomUUID().toString();
        when(targets.requireVisibleRealTask(alice.uid(), unknown))
            .thenThrow(new ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", "资源不存在"));
        assertThatThrownBy(() -> service.taskMembers(alice.uid(), unknown)).isInstanceOfSatisfying(ApiException.class,
            error -> assertThat(error.status()).isEqualTo(HttpStatus.NOT_FOUND));
    }

    @Test void visibleRealTargetUsesCreatorAndCanonicalUuidWithoutDemoOrDefaultTeamLookup() {
        String task = "aabbccdd-aabb-4aab-8aab-aabbccddeeff";
        var owner = new Member(bob.uid(), bob.username());
        when(targets.requireVisibleRealTask(alice.uid(), task)).thenReturn(owner);
        var provider = mock(DashboardMockFixtures.class);
        var result = new DashboardMockService(targets, provider).taskMembers(alice.uid(), task.toUpperCase(java.util.Locale.ROOT));
        verify(targets).requireVisibleRealTask(alice.uid(), task);
        verify(targets, never()).viewer(anyString());
        verifyNoInteractions(provider);
        assertThat(result.task_id()).isEqualTo(task);
        assertThat(result.mock()).isFalse();
        assertThat(result.owner_uid()).isEqualTo(bob.uid());
        assertThat(result.members()).containsExactly(owner);
    }

    @ParameterizedTest @ValueSource(strings = {"not-a-uuid", "1-1-1-1-1", "00000000-0000-0000-0000-00000000000g"})
    void invalidTaskIdsNeverReachDatabase(String value) {
        assertThatThrownBy(() -> service.taskMembers(alice.uid(), value)).isInstanceOf(ApiException.class);
        verify(targets, never()).requireVisibleRealTask(anyString(), anyString());
    }

    @Test void responseCollectionsCannotBeMutatedByConsumer() {
        var list = service.teamTasks(alice.uid(), alice.ownedTeamId());
        assertThatThrownBy(() -> list.items().clear()).isInstanceOf(UnsupportedOperationException.class);
        String task = UUID.randomUUID().toString();
        when(targets.requireVisibleRealTask(alice.uid(), task)).thenReturn(new Member(alice.uid(), alice.username()));
        var members = service.taskMembers(alice.uid(), task);
        assertThatThrownBy(() -> members.members().clear()).isInstanceOf(UnsupportedOperationException.class);
    }

    private RecentTaskCard recent(String id, String at) {
        return new RecentTaskCard(id, alice.ownedTeamId(), "合成任务", "示例数据", "none", Instant.parse(at));
    }
}
