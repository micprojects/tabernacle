# YouTube player test fixture

`youtube-player.webm` is a generated 20-second grey frame at 160 × 90 pixels,
1 fps, VP8, without audio. The native Firefox test uses it to verify actual
`HTMLMediaElement` duration and position without depending on a YouTube video's
ads, autoplay or account state.

Generated with:

```sh
ffmpeg -f lavfi -i color=c=gray:s=160x90:r=1 -t 20 -c:v libvpx -b:v 50k youtube-player.webm
```
