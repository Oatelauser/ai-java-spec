# p3c 评审规约(rule.json 维护源)

本文件是 `.opencodereview/rule.json` 的唯一维护源:改完跑 `node scripts/build-rules.js` 重新生成;不要手改 rule.json。

格式约定:按 `## 组名` 分节(组名去掉括号补注后作生成文本的行前缀);每条规则一行 `- [强制] 规则文本` 或 `- [建议] 规则文本`;其余行(空行/标题/说明)构建时忽略。评审导语与 exclude 骨架在 `scripts/build-rules.js` 里维护。

## 命名

- [建议] 类名UpperCamelCase:领域模型 DO/BO/DTO/VO/DAO 例外
- [强制] 抽象类以 Abstract 或 Base 开头
- [强制] 异常类以 Exception 结尾
- [建议] 测试类以被测类名开头、Test 结尾
- [强制] 方法/参数/成员变量/局部变量用 lowerCamelCase
- [强制] 命名不以 _ 或 $ 开头
- [强制] 常量全大写下划线分隔,语义完整不嫌名长
- [强制] Service/DAO 实现类以 Impl 结尾,对外暴露接口
- [建议] 包名全小写,点分隔间仅一个自然语义英语单词,用单数
- [强制] POJO 布尔属性不加 is 前缀,防序列化框架解析错误
- [建议] 数组写成 String[] args,中括号是类型一部分

## OOP

- [强制] equals 用常量或确定有值对象调用,防 NPE
- [强制] 包装类对象值比较用 equals,禁 ==(Integer 缓存区间外新建对象)
- [建议] POJO 属性与 RPC 参数/返回值用包装类型,局部变量用基本类型
- [建议] POJO 属性不加默认值
- [建议] POJO 写 toString,继承父 POJO 时前加 super.toString
- [建议] 循环内字符串拼接用 StringBuilder.append
- [建议] 禁 new BigDecimal(double)(精度损失),用字符串或 valueOf

## 并发

- [强制] 线程池禁 Executors 创建(无界队列/线程可致 OOM),用 ThreadPoolExecutor 显式指定参数
- [强制] 定时任务用 ScheduledExecutorService,不用 Timer(单任务异常全终止)
- [强制] 禁显式创建线程,线程须经线程池提供
- [强制] 线程池用带 ThreadFactory 的构造并指定有意义线程名,便于回溯
- [强制] SimpleDateFormat 线程不安全:禁 static 共享,加锁/ThreadLocal/JDK8 用 DateTimeFormatter
- [强制] 自定义 ThreadLocal 用毕必须 remove(线程复用致串数据/内存泄漏),try-finally 回收
- [建议] 避免多线程共用 Random 实例(竞争 seed 性能降),用 ThreadLocalRandom
- [建议] countDown 放 finally,防子线程异常致主线程 await 超时
- [强制] lock 须在 try 块外获取,unlock 放 finally 首行

## 集合

- [强制] 集合转数组用 toArray(new T[size]),禁无参 toArray 后强转
- [强制] Arrays.asList 是定长视图:add/remove/clear 抛 UnsupportedOperationException
- [强制] subList 结果不可强转 ArrayList,需要集合特性时新建包装
- [强制] 使用 subList 期间禁改原列表(ConcurrentModificationException)
- [强制] foreach 内禁 remove/add,删元素用 Iterator 方式
- [建议] 集合初始化指定容量,HashMap 按元素数/0.75+1 取整

## 常量

- [强制] long 字面量用大写 L(小写 l 与 1 混淆)
- [建议] 禁魔法值:未定义常量的字面量不得直接出现在代码

## 异常

- [建议] 返回基本类型的方法 return 包装对象,自动拆箱可能 NPE
- [强制] finally 禁 return(丢弃 try/catch 返回值)
- [建议] @Transactional 须指定 rollbackFor 或 catch 中手动回滚

## 注释

- [建议] 类/字段/方法注释用 javadoc 格式/** */,不用 // 与 /* */
- [建议] 抽象方法/接口方法必须 javadoc:说明做什么,含参数/返回/异常
- [建议] 类必须添加创建者 @author 信息
- [强制] 枚举字段必须注释说明用途
- [建议] 方法内单行注释置语句上方另起一行,用 //
- [建议] 及时清理废弃代码与配置

## 流程

- [强制] switch 每 case 以 break/return 终止或注释贯通,必有 default 置末
- [强制] if/else/for/while/do 必须大括号,单行也不省
- [建议] 复杂条件先赋值给有意义布尔变量再判断
- [建议] 避免取反运算符 !,存在对应正向写法

## 其他

- [强制] 正则预编译:Pattern 定义为常量,不在方法体内 compile
- [强制] 避免 Apache BeanUtils 拷贝属性(性能差),用 Spring BeanUtils/Cglib BeanCopier
- [强制] 取毫秒用 System.currentTimeMillis(),不用 new Date().getTime()
- [建议] Math.random() 范围 [0,1) 含 0 防除零;整数随机用 nextInt/nextLong
- [建议] 单方法总行数(含空行)不超 80
- [强制] 日期格式年用小写 y:大写 Y 是 week year,跨年错位
- [强制] 浮点等值判断禁 ==(基本类型)与 equals(包装),用误差范围或 BigDecimal

## 补充盲区(p3c 未覆盖)

- [强制] 异常禁吞噬:空 catch/仅注释/仅 printStackTrace 不允许,用日志带堆栈记录或有意义上抛
- [强制] 资源(流/连接)必须关闭:优先 try-with-resources
- [强制] 禁字符串拼接 SQL:JDBC 用 PreparedStatement 占位,MyBatis 用 #{} 而非 ${}
- [强制] 生产代码禁 System.out/err,统一日志框架
- [建议] RPC 返回/Map.get/查询结果使用前判空或 Optional
- [强制] 禁原始类型接收泛型集合(如 List list)
