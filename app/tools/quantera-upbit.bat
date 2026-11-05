@echo off
chcp 65001 >nul
title QUANTERA Upbit helper
set "QDIR=%~dp0"
set "QSELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText('%~f0',[Text.Encoding]::UTF8); iex ($s.Substring($s.IndexOf('#PS'+'START')))"
echo.
pause
exit /b
#PSSTART
# QUANTERA 업비트 도우미 (조회 전용)
# - 이 PC에서 업비트 API를 직접 부르고(업비트 키는 PC 밖으로 안 나감), 체결 내역을
#   1) 연결 코드가 있으면 QUANTERA 거래일지에 바로 올리고, 2) 없으면 파일로 저장합니다.
# - 업비트 키·연결 코드는 Windows 사용자 계정으로 암호화해 %APPDATA%\QUANTERA 에 둡니다.
# - 자동 실행: PC에 로그인하면 창 없이 뒤에서 계속 돌며 30초마다 새 체결을 확인해 바로 올림
#   (작업 스케줄러: 로그인할 때 + 1시간마다 살아 있는지 확인. 기록은 helper-log.txt)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$U8 = New-Object System.Text.UTF8Encoding($false)
$AUTO = ($env:QAUTO -eq '1')
$WATCH_SEC = 30
$SB_URL = 'https://owrtvchfcrpiwielyqvo.supabase.co'
$SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93cnR2Y2hmY3JwaXdpZWx5cXZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2NzcxODMsImV4cCI6MjEwNTI1MzE4M30.gLS438ACEIb9H_Art1HicRomcZO3CT0ctfpau93fPoc'
$TASK = 'QUANTERA Upbit'

$dir = Join-Path $env:APPDATA 'QUANTERA'; New-Item -ItemType Directory -Force -Path $dir | Out-Null
$keyFile = Join-Path $dir 'upbit-key.txt'; $codeFile = Join-Path $dir 'link-code.txt'
$stateFile = Join-Path $dir 'state.txt'; $logFile = Join-Path $dir 'helper-log.txt'
$ps1 = Join-Path $dir 'quantera-upbit.ps1'; $launcher = Join-Path $dir 'quantera-upbit-auto.vbs'

function Say($m, $c = 'Gray'){ if (-not $AUTO){ Write-Host $m -ForegroundColor $c } }
function Log($m){ try { Add-Content -Path $logFile -Value ("{0:yyyy-MM-dd HH:mm}  {1}" -f (Get-Date), $m) -Encoding UTF8 } catch {} ; Say $m }
function B64u([byte[]]$b){ [Convert]::ToBase64String($b).TrimEnd('=').Replace('+','-').Replace('/','_') }
function Plain([Security.SecureString]$ss){ [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)) }
function Seal([string]$t){ ConvertFrom-SecureString (ConvertTo-SecureString $t -AsPlainText -Force) }
function Unseal([string]$t){ Plain (ConvertTo-SecureString $t) }

# ---------- 저장된 키·코드
$access = $null; $secret = $null; $code = $null
if (Test-Path $keyFile){ try { $l = @(Get-Content $keyFile); $access = $l[0]; $secret = Unseal $l[1] } catch { $access = $null } }
if (Test-Path $codeFile){ try { $code = Unseal (@(Get-Content $codeFile)[0]) } catch { $code = $null } }
$lastTo = 0; if (Test-Path $stateFile){ try { $lastTo = [int64]@(Get-Content $stateFile)[0] } catch { $lastTo = 0 } }

function TaskOn(){ try { return [bool](Get-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue) } catch { return $false } }
function TaskInstall(){
  # 도우미 사본을 %APPDATA%\QUANTERA 에 두고, 창 없이 실행하는 작은 실행기(vbs)로 예약
  $src = [IO.File]::ReadAllText($env:QSELF, [Text.Encoding]::UTF8)
  [IO.File]::WriteAllText($ps1, $src.Substring($src.IndexOf('#PS'+'START')), (New-Object System.Text.UTF8Encoding($true)))
  $vbs = 'Set s = CreateObject("WScript.Shell")' + "`r`n" + 's.Environment("PROCESS")("QAUTO") = "1"' + "`r`n" + 's.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""' + $ps1 + '""", 0, False'
  [IO.File]::WriteAllText($launcher, $vbs, [Text.Encoding]::Unicode)
  WatchStop
  $act = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $launcher + '"')
  # 로그인할 때 시작 + 1시간마다 살아 있는지 확인 (이미 돌고 있으면 새로 뜬 쪽이 바로 끝남)
  $t1 = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Hours 1)
  $trig = @($t1)
  try { $trig += New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME" } catch {}
  $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $desc = 'QUANTERA: 업비트 체결을 30초마다 확인해 거래일지에 바로 올림'
  try { Register-ScheduledTask -TaskName $TASK -Action $act -Trigger $trig -Settings $set -Description $desc -Force | Out-Null }
  catch { Register-ScheduledTask -TaskName $TASK -Action $act -Trigger $t1 -Settings $set -Description $desc -Force | Out-Null }
  try { Start-Process wscript.exe -ArgumentList ('"' + $launcher + '"') } catch {}   # 지금 바로 뒤에서 시작
}
# 뒤에서 돌고 있는 도우미 멈추기
function WatchStop(){
  try { Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*quantera-upbit.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } } catch {}
}
function TaskRemove(){ try { Unregister-ScheduledTask -TaskName $TASK -Confirm:$false -ErrorAction SilentlyContinue } catch {}; WatchStop }

# ---------- 처음 설정 / 메뉴 (자동 실행일 땐 건너뜀)
$mode = 'push'
if (-not $AUTO){
  Write-Host '=== QUANTERA 업비트 도우미 ===' -ForegroundColor Green
  if (-not $access){
    Write-Host '업비트 Open API 키를 넣어 주세요. 자산조회·주문조회만 켠 키를 쓰세요.'
    $access = (Read-Host 'Access Key').Trim()
    $secret = (Plain (Read-Host 'Secret Key' -AsSecureString)).Trim()
    Set-Content -Path $keyFile -Value @($access, (Seal $secret))
    Write-Host '키를 이 PC에 암호화해 저장했어요.'
  } else { Write-Host "업비트 키: 저장됨 ($($access.Substring(0,6))…)" }
  if (-not $code){
    Write-Host ''
    Write-Host 'QUANTERA 설정 > 업비트 자동 올리기 > "코드 만들기"로 받은 연결 코드를 붙여 넣으세요.'
    Write-Host '(엔터만 누르면 파일로 저장하는 방식으로 진행해요)'
    $c = (Read-Host '연결 코드').Trim()
    if ($c){ $code = $c; Set-Content -Path $codeFile -Value @(Seal $code); Write-Host '연결 코드를 저장했어요.' }
  } else { Write-Host '연결 코드: 저장됨' }
  # 예전 버전(1시간마다)으로 켜 둔 경우 새 버전(실시간)으로 바꿔 둠
  if ((TaskOn) -and $code){ TaskInstall }
  Write-Host ("실시간 자동 올리기: " + $(if (TaskOn) { '켜짐 (PC가 켜져 있는 동안 30초마다)' } else { '꺼짐' }))
  Write-Host ''
  Write-Host '  1  지금 가져와서 거래일지에 올리기 (엔터)'
  Write-Host '  2  파일로 저장하기 (직접 올리기용)'
  Write-Host ('  3  실시간 자동 올리기 ' + $(if (TaskOn) { '끄기' } else { '켜기 (PC 켜면 뒤에서 30초마다)' }))
  Write-Host '  4  저장된 키·연결 코드 지우기'
  $pick = (Read-Host '번호').Trim()
  if ($pick -eq '2'){ $mode = 'file' }
  elseif ($pick -eq '3'){
    if (TaskOn){ TaskRemove; Write-Host '자동 실행을 껐어요.' -ForegroundColor Yellow; return }
    if (-not $code){ Write-Host '자동 실행은 연결 코드가 있어야 해요. 4번으로 지운 뒤 다시 실행해 코드를 넣어 주세요.' -ForegroundColor Yellow; return }
    TaskInstall; Write-Host '실시간 자동 올리기를 켰어요. PC가 켜져 있는 동안 뒤에서 30초마다 새 체결을 올려요.' -ForegroundColor Green
    return
  }
  elseif ($pick -eq '4'){ Remove-Item $keyFile, $codeFile, $stateFile -ErrorAction SilentlyContinue; TaskRemove; Write-Host '지웠어요. 다시 실행하면 처음부터 설정해요.'; return }
  if ($mode -eq 'push' -and -not $code){ $mode = 'file' }
  if ($mode -eq 'push' -and -not (TaskOn) -and $pick -ne '3'){
    if ((Read-Host '앞으로는 거래하면 저절로(30초 안에) 올라가게 켤까요? (y/n)') -match '^[yY]'){ TaskInstall; Write-Host '실시간 자동 올리기를 켰어요. 창을 닫아도 뒤에서 계속 돌아요.' -ForegroundColor Green }
  }
} else {
  if (-not $access -or -not $code){ Log ('자동 실행: ' + $(if (-not $access) { '업비트 키' } else { '연결 코드' }) + '를 못 읽어 건너뜀. bat를 다시 실행해 주세요.'); return }
  # 한 번에 하나만 (1시간마다 확인할 때 이미 돌고 있으면 바로 끝냄)
  $script:mx = New-Object Threading.Mutex($false, 'Local\QUANTERA_Upbit_Watch')
  try { if (-not $script:mx.WaitOne(0)){ return } } catch [Threading.AbandonedMutexException] {}
}

# ---------- 기간: 지난번 이후 (하루 겹쳐서 받음, 중복은 서버가 건너뜀). 처음엔 묻거나 30일
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
if ($mode -eq 'file' -or -not $lastTo){
  if ($AUTO){ $days = 30 } else {
    $days = Read-Host '며칠치를 가져올까요? (엔터 = 30일, 최대 365)'
    if (-not ($days -as [int])){ $days = 30 }; $days = [Math]::Min([int]$days, 365)
  }
  $from = $now - [int64]$days * 86400000
} else { $from = [Math]::Max($lastTo - 86400000, $now - [int64]365 * 86400000) }

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
      if ($msg -match 'invalid_access_key'){ throw "Access Key가 맞지 않아요. 도우미를 실행해 4번(지우기) 후 다시 넣어 주세요." }
      if ($msg -match 'jwt_verification'){ throw "Secret Key가 맞지 않아요. 도우미를 실행해 4번(지우기) 후 다시 넣어 주세요." }
      if ($msg -match 'expired_access_key'){ throw "업비트 키가 만료됐어요. 업비트에서 새로 발급해 주세요." }
      throw "업비트 오류: $msg $($_.Exception.Message)"
    }
  }
  throw '요청이 너무 많아요. 잠시 뒤 다시 실행해 주세요.'
}
function Push($chunk){
  $body = @{ p_code = $code; p_orders = @($chunk) } | ConvertTo-Json -Depth 8 -Compress
  try {
    return Invoke-RestMethod -Method Post -Uri "$SB_URL/rest/v1/rpc/q_upbit_push" -Headers @{ apikey = $SB_KEY; Authorization = "Bearer $SB_KEY" } -ContentType 'application/json; charset=utf-8' -Body ($U8.GetBytes($body))
  } catch {
    $m = "$($_.ErrorDetails.Message)"
    if ($m -match 'invalid_code'){ throw '연결 코드가 맞지 않거나 끊겼어요. QUANTERA 설정에서 새 코드를 만들고, 도우미 4번(지우기) 후 다시 넣어 주세요.' }
    throw "QUANTERA에 올리지 못했어요: $m $($_.Exception.Message)"
  }
}

function SyncOnce($from, $now){
  Say '업비트에서 체결 내역 확인 중…'
  $accounts = @()
  if ($mode -eq 'file'){ $accounts = @(Call 'accounts' '') }
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
    Say ("주문 목록 {0:yyyy-MM-dd} 주 확인" -f [DateTimeOffset]::FromUnixTimeMilliseconds($s).ToLocalTime())
  }
  $list = @($orders.Values); $full = @(); $n = 0
  foreach ($o in $list){
    $n++
    if (-not $o.trades -or @($o.trades).Count -eq 0){ $o = Call 'order' "uuid=$($o.uuid)"; Start-Sleep -Milliseconds 120 }
    $full += $o
    if ($n % 10 -eq 0){ Say "체결 내역 $n / $($list.Count)" }
  }

  if ($mode -eq 'file'){
    $out = [ordered]@{ format = 'quantera-upbit-v1'; from = $from; to = $now; createdAt = (Get-Date).ToString('o'); accounts = $accounts; orders = $full }
    $name = 'quantera-upbit-' + (Get-Date -Format 'yyyyMMdd-HHmm') + '.json'
    $base = $(if ($env:QDIR) { $env:QDIR } else { [Environment]::GetFolderPath('Desktop') })
    $path = Join-Path $base $name
    [IO.File]::WriteAllText($path, ($out | ConvertTo-Json -Depth 8 -Compress), $U8)
    Say ''
    Say "완료: 체결된 주문 $($full.Count)건을 저장했어요." 'Green'
    Say "파일: $path"
    Say 'QUANTERA > 거래일지 > 업비트 가져오기 > "파일 고르기"에서 이 파일을 고르세요.'
    Start-Process explorer.exe "/select,`"$path`""
  } else {
    $added = 0
    for ($i = 0; $i -lt $full.Count; $i += 200){
      $r = Push ($full[$i..([Math]::Min($i + 199, $full.Count - 1))])
      $added += [int]$r.added
    }
    Set-Content -Path $stateFile -Value @([string]$now)
    $script:lastTo = $now
    if ($added -gt 0 -or -not $AUTO){ Log ("올림: 확인한 체결 {0}건 중 새로 {1}건 추가" -f $full.Count, $added) }
    Say 'QUANTERA 거래일지에 바로 보여요.' 'Green'
  }
}

if ($AUTO){
  # 실시간: 처음엔 지난번 이후 전부, 그다음부턴 30초마다 최근 10분만 확인 (겹친 건 서버가 건너뜀)
  $fails = 0
  while ($true){
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    try { SyncOnce $from $now; $fails = 0; $from = $now - 600000 }
    catch { $fails++; if ($fails -le 3 -or $fails % 60 -eq 0){ Log ("실패: " + $_.Exception.Message) } }
    Start-Sleep -Seconds $(if ($fails -gt 3) { 300 } else { $WATCH_SEC })
  }
}
try {
  SyncOnce $from $now
} catch {
  Log ("실패: " + $_.Exception.Message)
  if (-not $AUTO){ Write-Host $_.Exception.Message -ForegroundColor Red }
}
