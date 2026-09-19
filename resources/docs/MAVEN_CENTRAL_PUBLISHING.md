# Maven 中央仓库发布知识

> 发布"操作流程"在 [RELEASE_PROCESS.md](RELEASE_PROCESS.md);本文只讲
> "把构件发到 Maven Central 所需的环境、账号、凭证与 deploy 配置"。
> 两份文档独立:纯项目用不到本文;只有公开发开源库才需要。

## 0. 前置认知:中央仓库不是你直接推的

Maven Central 由 Sonatype 运营。你不能直接 `mvn deploy` 推到 Central——你推的
是 Sonatype 的 staging 仓库,经"闭(close)→ 核(verify)→ 发(release)"后才
同步到 Central。历史上这套是 Nexus Staging 插件加手动闭/发;2024 年起 Sonatype
新开通的账号强制走"中央门户(central-publishing)"Maven 插件,老账号仍可用旧插件。
首次发布前先确认你属于哪套。

## 1. 账号与坐标

**账号**(二选一,取决于 Sonatype 给你的入口):

- **新入口(2024 后)**:在 https://central.sonatype.com 注册,一个账号对应一个
  namespace(个人用 `io.github.<user>`,组织用自有域名如 `com.<org>`),自助开通
  即时可用。
- **旧入口(Sonatype OSSRH)**:在 https://issues.sonatype.org 建 TICKET 申请
  namespace,需验证域名 DNS TXT 记录或 GitHub repo 权限,人工审核数天。

**坐标**:namespace 即 groupId 前缀。若 `com.example` 作 namespace,发布的所有
artifactId 都得以 `com.example` 开头——**自行编造 groupId 发不上去**。
artifactId、version 自定,但 version 不得是 SNAPSHOT(Central 不收 SNAPSHOT,
它只收正式版;SNAPSHOT 是给内部快照仓库的)。

## 2. 三件套:签名 / 源码 / 文档(Central 强制)

Central 对仓库有三条硬性要求,缺任何一条 close 阶段直接失败:GPG 签名、源码包、
javadoc 包。

### 2.1 GPG 签名

所有主构件加 asc 文件都要用 GPG 私钥签名。准备步骤:

```bash
# 生成密钥(用 RSA 4096,不要用默认 DSA)
gpg --full-generate-key
# 查看 KeyId(8 字节 16 进制,记下来,配置里 GPG_KEY_ID 就用它)
gpg --list-secret-keys --keyid-format=long
# 把公钥推到中央仓库能验证的服务器(至少推一个,Sonatype 用 ubuntu keyserver)
gpg --keyserver hkp://keyserver.ubuntu.com --send-keys <KEY_ID>
```

分发公钥是**常见踩坑点**:不推送公钥,Sonatype 验签失败但报错信息不直观
(报 "missing key" 而非 "public key not found")。至少推 keyserver.ubuntu.com
和 keys.openpgp.org 两个。

凭证塞进 `settings.xml` 的 `<server>` 里(见第 4 节),私钥 passphrase 走环境变量,
**不进仓库**。

Maven 端用 GPG 插件签名(plugin XML):

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-gpg-plugin</artifactId>
  <version>3.2.7</version>
  <executions>
    <execution>
      <id>sign-artifacts</id>
      <goals><goal>sign</goal></goals>
      <phase>verify</phase>
      <configuration>
        <keyname>${env.GPG_KEY_ID}</keyname>
        <passphrase>${env.GPG_PASSPHRASE}</passphrase>
        <gpgArguments>
          <arg>--pinentry-mode</arg><arg>loopback</arg>
        </gpgArguments>
      </configuration>
    </execution>
  </executions>
</plugin>
```

`--pinentry-mode loopback` 让 passphrase 从参数读,不在 Windows 弹窗——CI 必加。

### 2.2 源码包(source-jar)

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-source-plugin</artifactId>
  <version>3.3.1</version>
  <executions>
    <execution>
      <id>attach-sources</id>
      <goals><goal>jar-no-fork</goal></goals>
    </execution>
  </executions>
</plugin>
```

### 2.3 文档包(javadoc-jar)

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-javadoc-plugin</artifactId>
  <version>3.11.1</version>
  <configuration>
    <doclint>none</doclint>
    <failOnError>false</failOnError>
  </configuration>
  <executions>
    <execution>
      <id>attach-javadocs</id>
      <goals><goal>jar</goal></goals>
    </execution>
  </executions>
</plugin>
```

javadoc 失败是**最常见的 close 失败原因**:JDK 8+ 的 doclint 格式要求很严,
普通项目注释不全就炸,所以默认 `doclint>none` + `failOnError>false`。如果项目
追求严格,可改 `<doclint>all</doclint>` + `<failOnError>true</failOnError>`,但要
承担维护成本。

注意"假绿"陷阱:上面默认让构建过,但产物里 javadoc-jar 可能因解析错误而缺失,
close 阶段才报。发布前用 `mvn javadoc:jar` 单独验证一次。

## 3. 发布插件(二选一,取决于账号类型)

### 3a. 新入口:central-publishing-plugin(2024 后账号用这个)

```xml
<plugin>
  <groupId>org.sonatype.central</groupId>
  <artifactId>central-publishing-maven-plugin</artifactId>
  <version>0.6.0</version>
  <extensions>true</extensions>
  <configuration>
    <publishingServerId>central</publishingServerId>
    <tokenAuth>true</tokenAuth>
    <autoPublish>true</autoPublish>
  </configuration>
</plugin>
```

`publishingServerId` 的值要和 `settings.xml` 里 `<server>` 的 `id` 一字不差。

发布命令 `mvn clean deploy`。插件自动批量上传 → 闭 → 核 → 发;
`autoPublish=true` 则核通过后自动发布,不用手动按钮;失败也能在 central portal
手动批量重试。

### 3b. 旧入口:nexus-staging-maven-plugin(OSSRH 老账号用这个)

```xml
<plugin>
  <groupId>org.sonatype.plugins</groupId>
  <artifactId>nexus-staging-maven-plugin</artifactId>
  <version>1.7.0</version>
  <extensions>true</extensions>
  <configuration>
    <serverId>ossrh</serverId>
    <nexusUrl>https://s01.oss.sonatype.org/</nexusUrl>
    <autoReleaseAfterClose>true</autoReleaseAfterClose>
  </configuration>
</plugin>
```

注意 `s01.oss.sonatype.org` 是 2021 年后的新 OSSRH 实例;老账号(2021 年前开通)
仍用 `oss.sonatype.org`。开工前确认你账号对应哪个 URL,配错会 401。

## 4. credentials(settings.xml,不进仓库)

因账号类型不同,`<server>` 的认证字段不同。

### 新入口(central-publishing 用 token)

在 https://central.sonatype.com 生成 Portal Access User Token,得到 username 和
password 两个值(不是你账号邮箱)。写入 settings.xml:

```xml
<settings>
  <servers>
    <server>
      <id>central</id>
      <username>${env.CENTRAL_TOKEN_USER}</username>
      <password>${env.CENTRAL_TOKEN_PASS}</password>
    </server>
  </servers>
</settings>
```

### 旧入口(OSSRH 用账号密码加 GPG 属性)

```xml
<settings>
  <servers>
    <server>
      <id>ossrh</id>
      <username>${env.OSSRH_USER}</username>
      <password>${env.OSSRH_PASS}</password>
    </server>
  </servers>
  <profiles>
    <profile>
      <id>ossrh-gpg</id>
      <properties>
        <gpg.keyname>${env.GPG_KEY_ID}</gpg.keyname>
        <gpg.passphrase>${env.GPG_PASSPHRASE}</gpg.passphrase>
      </properties>
    </profile>
  </profiles>
  <activeProfiles>
    <activeProfile>ossrh-gpg</activeProfile>
  </activeProfiles>
</settings>
```

## 5. 发布操作流程(简版,详见 RELEASE_PROCESS.md)

发布日阶段 1 冻结版本号 → 阶段 3 双臂验证(这里"双臂"之一就是 Central 的 close
校验)→ 阶段 4 提交并执行:

```bash
mvn clean deploy -Possrh-release   # 或新入口去掉 profile 直接 deploy
```

- 新插件(autoPublish=true):deploy 完即自动闭核发,日志里看状态;约 10-30 分钟
  后构件出现在 https://central.sonatype.com/artifact/<groupId>/<artifactId>。
- 旧插件(autoReleaseAfterClose=true):deploy 触发 close,close 成功自动 release。
  close 失败去 https://s01.oss.sonatype.org 看 staging repo 的错误日志。
- 发布后中央索引同步通常 10-30 分钟;**检索页面**(search.maven.org 或
  mavencentral.com)可能要 2-4 小时才出现,别急着重发。

## 6. 常见陷阱

1. **公钥没推到 keyserver**:close 失败报 "missing key" / "no public key"。推到
   keyserver.ubuntu.com 和 keys.openpgp.org。
2. **SNAPSHOT version 发布**:Central 不收。发布前确认 pom.xml 的 version 是正式
   版,非 SNAPSHOT。
3. **javadoc 解析失败**:JDK 8+ doclint,配置 `<doclint>none</doclint>` +
   `<failOnError>false</failOnError>`。严格项目可加 `<doclint>all</doclint>`。
4. **javadoc"假绿"**:上面默认让构建过,但产物里 javadoc-jar 会缺失,close 阶段才
   报。发布前用 `mvn javadoc:jar` 单独验证一次。
5. **settings.xml server id 与 publishingServerId 不一致**:401 Unauthorized;
   两个字符串必须一字不差。
6. **旧 OSSRH URL 用错 s01 与非 s01**:老账号(2021 前)用 oss.sonatype.org,新账号
   用 s01.oss.sonatype.org;配错 401。
7. **凭证明文进 git**:GPG passphrase、OSSRH 密码、token 全部用 `${env.XXX}` 走环境
   变量,settings.xml 放 `~/.m2/` 不入库;CI 用 GitHub Actions secrets 或等价机制。
8. **重复发同一 version**:`mvn deploy` 会先生成新 staging repo 再把它推上去;同一
   正式版第二次 deploy 会失败(Central 不允许改写已发布版)。要重发得先手动 drop
   staging repo 再发,极度不推荐——宁可发下一个 patch。
9. **Windows 上 GPG 弹窗导致 CI 挂**:用 `--pinentry-mode loopback` 让 passphrase
   从参数读,Maven GPG 插件 3.x 默认已带,旧版需手动加 gpgArguments。
