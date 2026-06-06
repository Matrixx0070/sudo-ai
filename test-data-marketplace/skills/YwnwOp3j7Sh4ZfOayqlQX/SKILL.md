---
name: trello
description: Manage Trello boards, lists, and cards using the Trello REST API.
trigger: /trello, create card, trello board, add to trello, move card, trello list, trello task
allowed-tools: [web.fetch]
---

# Skill: Trello

## Purpose
Interact with Trello: create and update cards, move cards between lists, add comments,
list board contents, and manage labels — using the Trello REST API.

## When to use
- User wants to create a new Trello card or task
- User wants to see all cards on a board or in a list
- User wants to move a card to a different list (e.g., "In Progress" → "Done")
- User wants to add a comment or checklist to a card
- User wants to find a card by name

## How to use

1. Check that `TRELLO_KEY` and `TRELLO_TOKEN` are set in the environment.
   If missing, direct user to https://trello.com/app-key to obtain them.
   All requests append `?key=$TRELLO_KEY&token=$TRELLO_TOKEN`.
   Base URL: `https://api.trello.com/1`

2. **List boards:**
   - GET `<base>/members/me/boards?fields=name,id,url`

3. **List lists on a board:**
   - GET `<base>/boards/<board_id>/lists?fields=name,id`

4. **List cards on a board or list:**
   - Board: GET `<base>/boards/<board_id>/cards?fields=name,id,idList,due,desc`
   - List: GET `<base>/lists/<list_id>/cards`

5. **Create a card:**
   - POST `<base>/cards`
   - Body params: `idList=<list_id>&name=<title>&desc=<description>&due=<ISO date>`
   - Report the new card URL.

6. **Move a card to a different list:**
   - PUT `<base>/cards/<card_id>`
   - Body: `idList=<target_list_id>`

7. **Add a comment to a card:**
   - POST `<base>/cards/<card_id>/actions/comments`
   - Body: `text=<comment>`

8. **Add a checklist item:**
   - First create checklist: POST `<base>/checklists?idCard=<card_id>&name=Tasks`
   - Then add item: POST `<base>/checklists/<checklist_id>/checkItems?name=<item>`

9. **Find a board or list by name:**
   - List all boards/lists, filter by matching name (case-insensitive).

10. Use `$TRELLO_BOARD_ID` env var as the default board if set; otherwise ask the user.

## Requirements
- `TRELLO_KEY` — Trello API key from https://trello.com/app-key
- `TRELLO_TOKEN` — Trello OAuth token (generated from the same page).
- Optional: `TRELLO_BOARD_ID` — default board ID to avoid specifying it every time.

## Example
```
/trello create card "Fix login bug" in list "To Do" on board "Sprint 12"
/trello list board "Sprint 12"
/trello move card "Fix login bug" to "In Progress"
/trello comment on card <id> "PR opened: github.com/org/repo/pull/42"
```
