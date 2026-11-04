@echo off
chcp 65001 >nul
title QUANTERA Upbit export
set "QDIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText('%~f0',[Text.Encoding]::UTF8); iex ($s.Substring($s.IndexOf('#PS'+'START')))"
echo.
pause
exit /b
#PSSTART
# QUANTERA 업비트 거래내역 내보내기 (조회 전용)
# - 이 PC에서 업비트 API를 직접 부르고, 결과를 파일 하나로 저장합니다. 키와 기록은 어디에도 보내지 않아요.
# - 키는 Windows 사용자 계정으로 암호화해 %APPDATA%\QUANTERA\upbit-key.txt 에 둡니다 (다른 PC·다른 사용자는 못 읽음).
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$U8 = New-Object System.Text.UTF8Encoding($false)

function B64u([byte[]]$b){ [Convert]::ToBase64String($b).TrimEnd('=').Replace('+','-').Replace('/','_') }
function Plain([Security.SecureString]$ss){ [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)) }

$keyDir = Join-Path $env:APPDATA 'QUANTERA'; $keyFile = Join-Path $keyDir 'upbit-key.txt'
$access = $null; $secret = $null
if (Test-Path $keyFile){
  try { $l = Get-Content $keyFile; $access = $l[0]; $secret = Plain (ConvertTo-SecureString $l[1]) } catch { $access = $null }
  if ($access){ Write-Host "저장된 키를 씁니다 (Access Key $($access.Substring(0,6))…). 키를 바꾸려면 $keyFile 을 지우세요." }
}
if (-not $access){
  Write-Host '업비트 Open API 키를 넣어 주세요. 자산조회·주문조회만 켠 키를 쓰세요.'
  $access = (Read-Host 'Access Key').Trim()
  $secret = (Plain (Read-Host 'Secret Key' -AsSecureString)).Trim()
  if ((Read-Host '이 PC에 키를 암호화해 저장할까요? (y/n)') -match '^[yY]'){
    New-Item -ItemType Directory -Force -Path $keyDir | Out-Null
    $enc = ConvertFrom-SecureString (ConvertTo-SecureString $secret -AsPlainText -Force)
    Set-Content -Path $keyFile -Value @($access, $enc)
  }
}
$days = Read-Host '며칠치를 가져올까요? (엔터 = 30일, 최대 365)'
if (-not ($days -as [int])){ $days = 30 }; $days = [Math]::Min([int]$days, 365)

$hmac = New-Object Security.Cryptography.HMACSHA512 (,$U8.GetBytes($secret))
$sha = [Security.Cryptography.SHA512]::Create()
function Call($path, $query){
  $p = @{ access_key = $access; nonce = [guid]::NewGuid().ToString() }
  if ($query){ $p.query_hash = (($sha.ComputeHash($U8.GetBytes($query)) | ForEach-Object { $_.ToString('x2') }) -join ''); $p.query_hash_alg = 'SHA512' }
  $h = (B64u $U8.GetBytes('{"alg":"HS512","typ":"JWT"}')) + '.' + (B64u $U8.GetBytes(($p | ConvertTo-Json -Compress)))
  $jwt = $h + '.' + (B64u $hmac.ComputeHash($U8.GetBytes($h)))
  $url = "https://api.upbit.com/v1/$path" + $(if ($query) { "?$query" } else { '' })
  for ($i = 0; $i -lt 3; $i++){
    try { $r = Invoke-RestMethod -Uri $url -Headers @{ Authorization = "Bearer $jwt"; Accept = 'application/json' }; return $r }
    catch {
      $msg = $_.ErrorDetails.Message
      if ($msg -match 'too_many_requests' -or $_.Exception.Response.StatusCode.value__ -eq 429){ Start-Sleep -Milliseconds (1000 * ($i + 1)); continue }
      if ($msg -match 'no_authorization_ip'){ throw "허용되지 않은 IP예요. 업비트 Open API 관리에서 이 PC의 공인 IP를 등록해 주세요." }
      if ($msg -match 'out_of_scope'){ throw "키 권한이 부족해요. 자산조회·주문조회를 켜 주세요." }
      if ($msg -match 'invalid_access_key'){ throw "Access Key가 맞지 않아요. $keyFile 을 지우고 다시 실행하세요." }
      if ($msg -match 'jwt_verification'){ throw "Secret Key가 맞지 않아요. $keyFile 을 지우고 다시 실행하세요." }
      if ($msg -match 'expired_access_key'){ throw "키가 만료됐어요. 업비트에서 새로 발급해 주세요." }
      throw "업비트 오류: $msg $($_.Exception.Message)"
    }
  }
  throw '요청이 너무 많아요. 잠시 뒤 다시 실행해 주세요.'
}

try {
  Write-Host '잔고 확인 중…'
  $accounts = @(Call 'accounts' '')
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); $from = $now - [int64]$days * 86400000
  $WEEK = [int64]7 * 86400000
  $orders = @{}
  for ($s = $from; $s -lt $now; $s += $WEEK){
    $e = [Math]::Min($s + $WEEK - 1, $now)
    foreach ($st in 'done', 'cancel'){
      $start = $s
      while ($true){
        $page = @(Call 'orders/closed' "state=$st&start_time=$start&end_time=$e&limit=1000&order_by=asc")
        foreach ($o in $page){ if ([double]$o.executed_volume -gt 0 -and $o.market -like 'KRW-*'){ $orders[$o.uuid] = $o } }
        if ($page.Count -lt 1000){ break }
        $start = ([DateTimeOffset]::Parse($page[-1].created_at)).ToUnixTimeMilliseconds() + 1
        Start-Sleep -Milliseconds 150
      }
      Start-Sleep -Milliseconds 150
    }
    Write-Host ("주문 목록 {0:yyyy-MM-dd} 주 확인" -f [DateTimeOffset]::FromUnixTimeMilliseconds($s).ToLocalTime())
  }
  $list = @($orders.Values); $full = @(); $n = 0
  foreach ($o in $list){
    $n++
    if (-not $o.trades -or @($o.trades).Count -eq 0){ $o = Call 'order' "uuid=$($o.uuid)"; Start-Sleep -Milliseconds 120 }
    $full += $o
    if ($n % 10 -eq 0){ Write-Host "체결 내역 $n / $($list.Count)" }
  }
  $out = [ordered]@{ format = 'quantera-upbit-v1'; from = $from; to = $now; createdAt = (Get-Date).ToString('o'); accounts = $accounts; orders = $full }
  $name = 'quantera-upbit-' + (Get-Date -Format 'yyyyMMdd-HHmm') + '.json'
  $path = Join-Path $env:QDIR $name
  [IO.File]::WriteAllText($path, ($out | ConvertTo-Json -Depth 8 -Compress), $U8)
  Write-Host ''
  Write-Host "완료: 체결된 주문 $($full.Count)건을 저장했어요." -ForegroundColor Green
  Write-Host "파일: $path"
  Write-Host 'QUANTERA > 거래일지 > 업비트 가져오기 > "파일 올리기"에서 이 파일을 고르세요.'
  Start-Process explorer.exe "/select,`"$path`""
} catch {
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
}
