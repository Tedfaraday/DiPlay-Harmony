param([string]$Root=$PSScriptRoot)
$ErrorActionPreference='Stop'
$plan=Get-Content -Raw -LiteralPath "$Root\build\animation-plan.json" | ConvertFrom-Json
$taskApp=New-Object -ComObject PowerPoint.Application
$taskDeck=$null
try {
 $taskDeck=$taskApp.Presentations.Open("$Root\build\design-named.pptx",0,0,0)
 $taskCount=0
 foreach($page in $plan){
  $slide=$taskDeck.Slides.Item([int]$page.slide)
  $previousStart=0.0
  foreach($item in ($page.effects | Sort-Object start)){
   $shape=$null
   foreach($candidate in $slide.Shapes){if((!$item.image -and $candidate.Name -eq $item.key) -or ($item.image -and $candidate.AlternativeText -eq $item.key)){$shape=$candidate;break}}
   if($null -eq $shape){throw ('Missing animation target '+$page.slide+': '+$item.key)}
   $effect=$slide.TimeLine.MainSequence.AddEffect($shape,[int]$item.effect,0,2)
   $effect.Timing.Duration=[single]$item.duration
   $effect.Timing.TriggerDelayTime=[single]$item.start
   $previousStart=[double]$item.start
   if($item.effect -eq 22){$effect.EffectParameters.Direction=4}
   if($item.kind -eq 'slowzoom'){
    foreach($behavior in $effect.Behaviors){if($behavior.Type -eq 3){$behavior.ScaleEffect.FromX=100;$behavior.ScaleEffect.FromY=100;$behavior.ScaleEffect.ToX=104;$behavior.ScaleEffect.ToY=104}}
    $effect.Timing.SmoothStart=-1;$effect.Timing.SmoothEnd=-1
   }
   if($item.kind -eq 'down'){
    $behavior=$effect.Behaviors.Add(1);$behavior.MotionEffect.ByX=0;$behavior.MotionEffect.ByY=4
    $effect.Timing.AutoReverse=-1;$effect.Timing.RepeatCount=2
   }
   if($item.kind -eq 'rotate'){
    $behavior=$effect.Behaviors.Add(4);$behavior.RotationEffect.By=180
   }
   if($item.effect -eq 39 -or $item.effect -eq 42){$effect.Timing.SmoothStart=-1;$effect.Timing.SmoothEnd=-1}
   $taskCount++
  }
  $transition=$slide.SlideShowTransition
  $transition.EntryEffect=3849
  $transition.Duration=0.7
  $transition.AdvanceOnClick=0
  $transition.AdvanceOnTime=-1
  $transition.AdvanceTime=[single]$page.duration
  $slide.Export("$Root\build\slide-$($page.slide).png",'PNG',1920,1080)
  Write-Output ('Slide '+$page.slide+': '+$slide.Shapes.Count+' objects, '+$slide.TimeLine.MainSequence.Count+' timed animations')
 }
 $taskDeck.SlideShowSettings.AdvanceMode=2
 $taskDeck.SlideShowSettings.ShowType=1
 $taskDeck.SlideShowSettings.LoopUntilStopped=0
 $taskDeck.SlideShowSettings.ShowWithAnimation=-1
 $taskDeck.SaveAs("$Root\build\animated-candidate-v2.pptx",24)
 Write-Output ('Native animations saved: '+$taskCount)
 $taskDeck.Close();$taskDeck=$null
} finally {
 if($null -ne $taskDeck){$taskDeck.Close()}
 if($taskApp.Presentations.Count -eq 0){$taskApp.Quit()}
 [System.Runtime.InteropServices.Marshal]::ReleaseComObject($taskApp) | Out-Null
}


