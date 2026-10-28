// Temporary PATH-only CLI transport. Never discovers credentials or a real CLI.
using System;
using System.IO;
using System.Net;
using System.Text;
using System.Collections.Generic;
using System.Web.Script.Serialization;
class Bridge {
  static int Main(string[] args) {
    try {
      Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
      var json = new JavaScriptSerializer { MaxJsonLength = 8000000 };
      var cfg = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "bridge.json")));
      var url = new Uri((string)cfg["url"]);
      if (url.Scheme != "http" || url.Host != "127.0.0.1") throw new Exception("loopback required");
      string input = args.Length > 0 && args[0] == "exec" ? Console.In.ReadToEnd() : "";
      byte[] body = Encoding.UTF8.GetBytes(json.Serialize(new { args = args, input = input, cwd = Environment.CurrentDirectory }));
      var req = (HttpWebRequest)WebRequest.Create(url); req.Proxy = null; req.Method = "POST";
      req.Timeout = 190000; req.ReadWriteTimeout = 190000; req.ContentType = "application/json";
      req.Headers["X-Runner-Nonce"] = (string)cfg["nonce"]; req.ContentLength = body.Length;
      using (var s = req.GetRequestStream()) s.Write(body, 0, body.Length);
      using (var resp = req.GetResponse()) using (var r = new StreamReader(resp.GetResponseStream(), Encoding.UTF8)) {
        string line; while ((line = r.ReadLine()) != null) {
          var frame = json.Deserialize<Dictionary<string, object>>(line); string kind = (string)frame["channel"];
          if (kind == "stdout") { Console.Out.Write((string)frame["data"]); Console.Out.Flush(); }
          else if (kind == "stderr") { Console.Error.Write((string)frame["data"]); Console.Error.Flush(); }
          else if (kind == "done") return Convert.ToInt32(frame["code"]);
          else throw new Exception("invalid transport frame");
        }
      }
      throw new Exception("transport ended without completion");
    } catch { Console.Error.WriteLine("Foundation evaluation transport stopped"); return 78; }
  }
}
