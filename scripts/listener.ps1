$logFile = Join-Path $PSScriptRoot 'listener.log'
function Log($msg) {
    $msg | Out-File -FilePath $logFile -Append -Encoding Default
}

try {
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:17888/api/generate")
    $listener.Start()
    Log "正在监听 17888 端口的 POST 数据..."

    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        
        Log "`n================ [收到新请求] ================"
        Log "$($request.HttpMethod) $($request.Url)"
        
        # 打印 Headers
        Log "--- Headers ---"
        foreach ($key in $request.Headers.AllKeys) {
            # 使用 ${key} 避免与冒号产生语法冲突
            Log "${key}: $($request.Headers[$key])"
        }
        
        # 打印 POST Body
        Log "--- Body ---"
        $reader = New-Object System.IO.StreamReader($request.InputStream, $request.ContentEncoding)
        Log $reader.ReadToEnd()
        
        # 返回 200 OK 响应
        $response = $context.Response
        $buffer = [System.Text.Encoding]::UTF8.GetBytes('{"status":"ok"}')
        $response.ContentLength64 = $buffer.Length
        $response.OutputStream.Write($buffer, 0, $buffer.Length)
        $response.Close()
    }
} catch {
    Log "ERROR: $_"
    Log $_.ScriptStackTrace
}
