# 完整要求到参考稿：离线修订版

本目录是旧封存样本 foundation-notice-acceptance-20261028 的离线覆盖修订层，不是新模型评测样本。metadata.json绑定旧seal；旧题面、来源、gold、两篇固定错误稿均保留原字节。references.json只给P01参考通知补上用户description指定的低温柜对象，不改变条件、标点或proposal片段。

requirements.json由只读完整输入、未读gold/实现的独立代理提取：174条义务、2条许可。kind描述约束类别；processOnly=true表示需运行记录判断而非看文稿。这包含5条原稿不可替换等行为限制，原始提取私有记录保持不变。coverage.json给出187个阶段绑定，其中117个covered、15个固定稿expected_violation、55个process_only。process_only均未执行，不能据文本审查认定运行成功。

输入逐字引用、UTF-16稿件定位、完整阶段数量与内容身份由 ../foundation-coverage/validate.cjs 检查。这些是结构保证，不能证明语义正确。coverage-review.json由另一代理从完整输入、来源和每篇稿件独立反查，并绑定整份输入、清单、稿件和映射身份；任一改变必须重新审查。6篇正向参考稿（含门检、P03初终稿）合格，2篇固定负例仍不合格。标题与正文都补写低温柜是编辑选择，用户只要求主题明确，并非新增强制重复。

运行结构和审查身份检查：node evaluations/foundation-coverage/validate.cjs。回归：node --test evaluations/foundation-coverage/validate.test.cjs。命令从仓库根运行；均不调用模型、CLI或应用。source-only回放脚本另需匹配的本地候选ASAR并只写一次固定结果；它验证一个局部规则反例，不执行完整应用生命周期或真人验收。

本轮已经完成一次P01回放：完整合格稿仍被n1标记问题拦截。产品和当前安装版未改；没有真实质量率或token成本结论。旧参考稿仍不合格，不能用修订后的结果回填旧轮误拦率。
