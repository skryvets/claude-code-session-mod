# session

A Claude Code mod that draws session info under the prompt, in colour

```
claude-opus-5-5 · high · ~/Code/app (main)

Context: ██░░░░░░ 46.1K (23%)

Session: ██████░░ 73% used · 16% in reserve · lasts until reset · resets in 33m

Weekly:  ███░░░░░ 40% used · 9% in deficit · runs out in 3d 2h · resets in 4d 0h
```

## What it shows

- Model, effort level, folder and git branch
- Context window: tokens used and percent
- Session (5 hour) and Weekly (7 day) subscription limits: percent used, pace, forecast and time until reset

## How to read the pace

- `on pace` - within 2 points of spending the limit evenly across the window
- `N% in reserve` - you have used less than even spending would
- `N% in deficit` - you have used more than even spending would
- `lasts until reset` / `runs out in …` - a straight-line forecast from your spending so far
- No pace is shown until 3% of the window has passed (9 minutes for Session, about 5 hours for Weekly)

Bars are green, then yellow, then red: context turns yellow at 70% and red at 90%, limits turn yellow in deficit and red past 12 points of deficit

## Install

Type this at the prompt of a Claude Code terminal session:

```
/plugin install session --marketplace skryvets/claude-code-session-mod
```

Answer `y` to add the marketplace, then pick the user scope

## Notes

- Mods are an early access feature of Claude Code, so the API this uses may change between releases. Written against Claude Code 2.1.296
- The effort level appears after the first prompt of a session
- Limits only show on a Claude subscription

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## Credits

The pace rules follow [CodexBar](https://github.com/steipete/CodexBar) by Peter Steinberger
