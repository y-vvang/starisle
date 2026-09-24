// ILIKE 模式的通配符转义。用户输入里的 % 与 _ 是 LIKE 自身的元字符:
// 搜「100%」会匹配一切、搜「_」匹配任意单字符;反斜杠是 PG LIKE 的默认
// 转义符,所以把它们都前置一个 \ 即可(绑定参数不受 standard_conforming_strings
// 影响,不需要显式 ESCAPE 子句)。调用方负责再包一层 %...%。
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, c => '\\' + c);
