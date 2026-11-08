function n(r){let t=r.trim(),e=/(?:^|\r?\n)[ \t]*(?:User Safety|Response Safety)[ \t]*:[ \t]*safe[ \t]*$/i;for(;e.test(t);)t=t.replace(e,"").trimEnd();return t}export{n as a};
