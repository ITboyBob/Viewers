import type { CollaborationRecipient } from '@ohif/core';

/** 全部是合成演示用户，绝不代表真实注册表或当前团队成员查询结果。 */
export const collaborationFixtures: readonly CollaborationRecipient[] = Object.freeze(
  [
    {
      uid: 'synthetic:chen',
      username: '陈晨',
      avatar_url: null,
      synthetic: true as const,
      in_team: true,
    },
    {
      uid: 'synthetic:li',
      username: '李敏',
      avatar_url: null,
      synthetic: true as const,
      in_team: true,
    },
    {
      uid: 'synthetic:zhou',
      username: '周宁',
      avatar_url: null,
      synthetic: true as const,
      in_team: false,
    },
  ].map(user => Object.freeze(user))
);
