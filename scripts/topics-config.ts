/**
 * 主题配置文件
 * 定义核心业务主题，用于跨群 Q&A 提取
 */

export interface TopicConfig {
  name: string;              // 主题名称
  keywords: string[];        // 关键词组合
  priority: number;          // 优先级 1-5（5 最高）
  relatedGroups?: string[];  // 相关群组（可选，缩小搜索范围）
  timeRange?: {              // 可选时间范围
    start: string;           // YYYY-MM-DD
    end: string;             // YYYY-MM-DD
  };
}

/**
 * 核心业务主题清单
 * 按优先级排序，高优先级主题优先提取
 */
export const TOPICS: TopicConfig[] = [
  // ========== 高优先级主题（5分）==========
  {
    name: 'FIX协议对接',
    keywords: ['FIX', 'fix协议', 'fix接入', 'fix认证', 'fix下单', 'tag', 'Tag'],
    priority: 5
  },
  {
    name: 'API认证问题',
    keywords: ['认证失败', 'token过期', 'API密钥', '签名错误', '登录失败'],
    priority: 5,
  },
  {
    name: '交易拒单处理',
    keywords: ['拒单', '订单被拒', '下单失败', '资金不足', '持仓不足'],
    priority: 5,
  },

  {
    name: '接入方式',
    keywords:['专线', 'API', 'api', 'Colo', 'colo', '托管', '机房', '交叉连接', 'VPN', 'vpn', '光纤', '网络接入', '线路', '带宽', '机柜'],
    priority: 4,
  },

  // ========== 中高优先级主题（4分）==========
  {
    name: '北上资金数据',
    keywords: ['北上', '南下', '港股通', '沪深港通', '北向资金'],
    priority: 4,
    relatedGroups: ['磐松', '孝庸'],
  },
  {
    name: '估值计算',
    keywords: ['估值', 'NAV', '净值计算', '盯市', '估值表'],
    priority: 4,
    relatedGroups: ['Jinde'],
  },
  {
    name: '风控配置',
    keywords: ['风控', '限额', '预警', '熔断', '风险控制'],
    priority: 4,
  },
  {
    name: '断线重连机制',
    keywords: ['断线', '重连', '连接断开', '心跳', '网络中断'],
    priority: 4,
  },

  // ========== 中等优先级主题（3分）==========
  {
    name: '交易数据加工',
    keywords: ['数据加工', '成交回报', '持仓', '资金', '交易明细'],
    priority: 3,
    relatedGroups: ['Schonfeld'],
  },
  {
    name: '开户流程',
    keywords: ['开户', '账户开通', 'KYC', '合规审核', '开户资料'],
    priority: 3,
  },
  {
    name: '查询功能',
    keywords: ['持仓查询', '资金查询', '订单查询', '成交查询', '查询接口'],
    priority: 3,
  },
  {
    name: '算法单',
    keywords: ['TWAP', 'VWAP', '算法单', '算法交易', 'POV'],
    priority: 3,
  },

  // ========== 低优先级主题（2分）==========
  {
    name: '系统部署',
    keywords: ['部署', '上线', '环境配置', '服务器', '安装'],
    priority: 2,
  },
  {
    name: '时延优化',
    keywords: ['时延', '延迟', '性能优化', '加速', '响应时间'],
    priority: 2,
  },
  {
    name: '日志排查',
    keywords: ['日志', 'log', '排查', '调试', '错误日志'],
    priority: 2,
  },
];

/**
 * 根据主题名称获取配置
 */
export function getTopicConfig(name: string): TopicConfig | undefined {
  return TOPICS.find(t => t.name === name);
}

/**
 * 获取高优先级主题（优先级 >= 4）
 */
export function getHighPriorityTopics(): TopicConfig[] {
  return TOPICS.filter(t => t.priority >= 4);
}

/**
 * 按优先级排序的主题列表
 */
export function getTopicsByPriority(): TopicConfig[] {
  return [...TOPICS].sort((a, b) => b.priority - a.priority);
}

/**
 * 标准 QA 标签列表
 * 用于 LLM 提取时严格分类
 */
export const QA_TAGS = [
  // 技术类
  'FIX', 'FIXSERVER', 'GFGFIX', 'COLO', '专线',  'API接口', 'VPN', '鉴权认证', '环境部署', '参数配置', '延迟优化', '数据格式', 'FIX报文',
  
  // 业务类
  '交易规则', '费率',  '限额', '流速', '风控规则', '算法交易', '保证金', '北向极速', '北向借券', '盈亏计算', 'KYC', '开户流程', '日终文件', '估值报告',
  
  // 故障类
  '拒单分析', '断线重连', '系统异常',
  
  // 资源类
  '白名单', '黑名单'
];
