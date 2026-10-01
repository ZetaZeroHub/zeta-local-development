import Foundation
import Security

func finish(_ status: Int32) -> Never { exit(status) }
let data = FileHandle.standardInput.readDataToEndOfFile()
guard let item = try? JSONSerialization.jsonObject(with: data) as? [String:String],
      let op = item["operation"], let account = item["account"], !account.isEmpty else { finish(2) }
let query: [String:Any] = [kSecClass as String:kSecClassGenericPassword,
 kSecAttrService as String:"com.zetastudio.local-development",
 kSecAttrAccount as String:account]
switch op {
case "set":
 guard let token = item["token"], let bytes = token.data(using:.utf8) else { finish(2) }
 let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String:bytes] as CFDictionary)
 if update == errSecItemNotFound {
  var insert = query; insert[kSecValueData as String] = bytes
  insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
  finish(SecItemAdd(insert as CFDictionary,nil) == errSecSuccess ? 0 : 3)
 }
 finish(update == errSecSuccess ? 0 : 3)
case "get":
 var read = query;read[kSecReturnData as String] = true;read[kSecMatchLimit as String] = kSecMatchLimitOne
 var result:CFTypeRef?
 let status = SecItemCopyMatching(read as CFDictionary,&result)
 if status == errSecItemNotFound { finish(4) }
 guard status == errSecSuccess, let value = result as? Data else { finish(3) }
 FileHandle.standardOutput.write(value);finish(0)
case "delete":
 let status = SecItemDelete(query as CFDictionary)
 finish(status == errSecSuccess || status == errSecItemNotFound ? 0 : 3)
default:finish(2)
}
