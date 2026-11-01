// Jest配置由Node以CommonJS加载，与其他扩展保持一致。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config.base.js');

module.exports = {
  ...base,
  displayName: '显微镜共享视图就绪',
  transform: {
    '^.+\\.[jt]sx?$': ['babel-jest', { configFile: require.resolve('../../babel.config.js') }],
  },
  transformIgnorePatterns: ['/node_modules/'],
};
