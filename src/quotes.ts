/**
 * The daily quote — one cheerful Chinese one-liner under the welcome banner
 * (see messages.ts renderWelcome). A pool of 100 hand-written lines, one
 * random pick per TUI session: the pick is made once at renderer
 * construction, so relayout and theme switches re-render the same line and
 * only a fresh session (or /reload) rolls a new one.
 *
 * Every quote is plain CJK text — no emoji, no ANSI — at most 20 full-width
 * characters (40 terminal columns), so the formatted line ("「" + quote +
 * "」", +4 columns) always fits under the 94-column banner and can only need
 * clipping on genuinely narrow terminals (renderWelcome clips with
 * clipToWidth before styling — the repo rule, ANSI never goes through the
 * clipper). Chinese punctuation is full-width (,、:! are 2 columns like the
 * characters — visibleWidth accounts for it).
 */

/** The quote pool — 100 unique lines, one is shown per session. */
export const DAILY_QUOTES: readonly string[] = [
  // 开工元气
  '今天也要开开心心呀',
  '好事正在路上,慢慢来',
  '你比昨天又厉害了一点点',
  '元气满满,出发!',
  '微笑是今天最好的开场白',
  '深呼吸,一切都会好的',
  '今天的风也站在你这边',
  '今天的任务是:开心',
  '简单点,开心点',
  '把今天过成喜欢的样子',
  // 程序员幽默
  '摸鱼也是生产力的一部分',
  '代码能跑,就先别动它',
  'bug 是明天的,开心是今天的',
  '心情好,代码都少几个 bug',
  '万事开头难,然后就很爽',
  '先完成,再完美',
  '高手的秘诀:多练,多睡,多笑',
  '把烦恼丢进回收站,记得清空',
  '打不倒你的,都在给你攒经验值',
  '偶尔宕机,是为了更好地重启',
  // 小确幸
  '喝口热水,烦恼减半',
  '好好吃饭,是最朴素的浪漫',
  '一杯茶,一段好时光',
  '今天的你,值得一块小蛋糕',
  '难过的话,就先吃点甜的',
  '无论如何,先吃顿好的',
  '早餐吃好,一天都好',
  '泡面的三分钟,也值得期待',
  '微波炉叮的一声,是世界在说你好',
  '冬天的被窝,夏天的西瓜,都值得',
  // 鼓励打气
  '你已经在变好的路上了',
  '小小进度也是进度',
  '一步一步来,比较快',
  '别慌,月亮也在海上漂着呢',
  '会好的,而且会很好',
  '累了就休息,不是放弃',
  '你比你想象的更能扛',
  '别怕,大不了重新开始',
  '你努力的样子真的很酷',
  '今天的烦恼,明天看都是小事',
  // 自然治愈
  '出太阳了,晒晒心情',
  '云是天空的小绵羊',
  '落日是白天的温柔谢幕',
  '面朝大海,春暖花开',
  '星星不会因为天黑就不亮',
  '春天在口袋里偷偷发芽',
  '晚风会把白天的疲惫吹走',
  '今天的花,今天开',
  '眼里有光,哪里都是舞台',
  '阳光免费,心情也免费',
  // 自我关怀
  '允许自己摆烂五分钟',
  '偶尔发呆,是大脑在充电',
  '睡个好觉,明早又是新的',
  '别和自己较劲,和自己击个掌',
  '乖,摸摸头,没事的',
  '冷水洗脸,清醒又快乐',
  '遇到困难先睡一觉,明天再战',
  '唱歌跑调也要大声唱',
  '笑一笑,十年少,先笑为敬',
  '今天也记得夸夸自己',
  // 你很棒
  '你很重要,真的',
  '你的存在就是一件好事',
  '世界因你多了一点可爱',
  '你是自己的锦鲤',
  '你是限量版,全球仅此一件',
  '今天的你也很棒,辛苦啦',
  '你被这个世界温柔以待着',
  '世界很大,你的开心更大',
  '今天也是被宇宙爱着的一天',
  '好运正在派件,请保持好心情',
  // 生活趣味
  '周五的下午,空气都是甜的',
  '咸鱼翻身,还是咸鱼,但很快乐',
  '猫一天要睡十六个小时,学着点',
  '今天适合听一首喜欢的歌',
  '今天适合提前十分钟下班',
  '计划表上写:今天要快乐',
  '心中有海,哪里都是马尔代夫',
  '偶尔迷路,才能遇到新风景',
  '跑起来,风就来了',
  '好天气是自己给的',
  // 鲸鱼与海(呼应开场的那只)
  '鲸鱼都要浮上来换气,你也歇会儿',
  '鲸鱼今天也在海里开心地游',
  '大海不急,鲸鱼也不急',
  '浪花拍岸,是海在鼓掌',
  '潜得深,是为了跳得高',
  '鲸鱼唱歌的频率,刚好治愈人心',
  '海的那边,还是海,还是很好玩',
  '潮水退了还会再来,好运也是',
  '风浪越大,鱼越贵,你越强',
  '今天的海是蓝色的,心情是彩色的',
  // 收尾祝福
  '保持热爱,奔赴山海',
  '生活明朗,万物可爱',
  '明天的你,会感谢今天没放弃的自己',
  '你种下的努力,正在发芽',
  '今天的运气藏在微笑里',
  '今日宜:喝茶,吹风,想点好事',
  '世界很大,幸福很小,但刚刚好',
  '快乐是可以自己生产的',
  '会有人因为遇见你而开心',
  '今天,也要记得喜欢自己呀',
]

/**
 * Roll the session's quote. `rand` is injectable for tests (defaults to
 * Math.random); a uniform pick from DAILY_QUOTES.
 */
export function pickDailyQuote(rand: () => number = Math.random): string {
  return DAILY_QUOTES[Math.min(DAILY_QUOTES.length - 1, Math.floor(rand() * DAILY_QUOTES.length))]
}

/**
 * Format one quote for display: CJK corner brackets, no trailing spaces —
 * `「今天也要开开心心呀」`. The brackets are full-width (2 columns each),
 * +4 columns over the quote's own width.
 */
export function formatDailyQuote(quote: string): string {
  return `「${quote}」`
}
