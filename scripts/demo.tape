# The 22-second cut, as a script rather than a screen recording.
#
#   brew install vhs
#   vhs scripts/demo.tape        # → dist/demo.mp4
#
# VHS drives a real terminal and renders the result to video, so this is the
# actual output of the actual code — not a mockup, and not a take that has to be
# got right on the day. Every run is byte-identical, which means you can adjust
# one number and re-render rather than filming again.
#
# Square on purpose. A terminal cropped to 9:16 wraps the git log lines, which
# destroys the alignment the whole shot depends on. Render square and place it
# in the middle of a vertical canvas with your text above and below — that is
# where the hook and the caption want to live anyway.

Output dist/demo.mp4
Output dist/demo.gif

Set Shell "bash"
# A fallback chain, not a single name. "SF Mono" alone silently fell back to a
# proportional face inside the headless terminal VHS renders in — every line
# wrapped, and the column alignment that is the entire point of the shot went
# with it. Menlo ships with every macOS; the rest cover Linux and Windows.
Set FontFamily "JetBrains Mono,Menlo,DejaVu Sans Mono,Consolas,monospace"
Set FontSize 26
Set Width 1000
Set Height 400
Set Padding 40
Set TypingSpeed 60ms
Set Framerate 60

# A near-black ground rather than pure black: pure black clips on phone screens
# and eats the descenders. The green is git's own diff-add green, so the frame
# looks like a terminal rather than like a brand.
Set Theme { "background": "#0F1115", "foreground": "#E6E3DD", "cursor": "#7EE787", "black": "#0F1115", "white": "#E6E3DD" }

Hide
Type "cd ~/code/multiplayer-agent && clear" Enter
Sleep 1s
Show

# Beat one: the command lands, and nothing happens yet. This pause is where the
# "watch the author column" overlay goes in the edit — it needs air.
Type "node scripts/demo-provenance.js --quiet"
Sleep 1500ms
Enter

# The demo clones a repository, has three agents write to it concurrently, and
# commits each write as the agent that made it. Six seconds is the real cost of
# doing that; speed-ramp it in the edit rather than cutting it, so the video
# does not claim to be faster than the thing is.
Sleep 6s

# Beat two: hold on the author column. Four and a half seconds feels long while
# you are editing and is exactly right while watching — the viewer has to read
# five names and notice they differ.
#
# It ends here on purpose. The obvious third beat is to run another `git log` to
# prove the repository is real, but the demo builds its repository in a temp
# directory and removes it, so a second command would run in *this* project and
# show your own commits — undermining the exact claim it was added to support.
# `--keep` leaves the repository behind if you want to film that separately.
Sleep 4500ms
