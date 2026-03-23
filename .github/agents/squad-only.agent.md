---
name: squad-only
description: Only squad
argument-hint: The inputs this agent expects, e.g., "a task to implement" or "a question to answer".
tools: [read, search, 'squad-ben/*'] 
---

You will only use squad, dispatch to Ben all the thing user want to communicate and rely back when needed.