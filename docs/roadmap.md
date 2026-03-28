# Future Development Roadmap  

Below you will find a comprehensive list of items planned for implementation in future updates.

***If you have suggestions for how to make TAK Portal better, please reach out to me directly or by opening an "Issue" on Github! I always want to know how this can better serve you and your agency.***

## High / In Progress
- Add locate functionality with texting service to send a link to missing persons
- Create Getting Started / Basic User Guides for TAK Aware, ATAK, and Open TAK Tracker
- Add access level between Agency and Global that has Global Admin access, but without access to server settings or audit log.  (Helpful for trusted EOC high level users)

## Medium
- Adding a "timeout/sandbox" group so instead of deleting a user with the delete button, requiring a restart, it removes all groups and adds them to a single "special" write only group to remove their access.  Then create a tab for the global admin of all the pending user deletions that need to take place before a restart.
- Implement Device Profile management
- Implement TAK Server Data Sync Mission Management
- Implement TAK Server Data Package Management


## Food For Thought / Unassigned
- Expand Mutual Aid to allow Agency Admins to access the page and create events for their agency channels only
- Add ability to delete a mutual aid user while leaving the mutual aid channel intact
- Consider adding a "timeout/sandbox" group so instead of deleting a user with the delete button, requiring a restart, it removes all groups and adds them to a single "special" write only group to remove their access.  Then create a tab for the global admin of all the pending user deletions that need to take place before a restart.


## Locate Plans:
- Locate settings will be in server settings.  Will need the ability to set the group that locate goes to, as well as data sync mission???.  Once configured, will need to SSH to TAK Server and add <locate enabled="true" requireLogin="false" cot-type="a-h-G" group="Group Name" addToMission="true" mission="Mission Name"/> before vbm setting at bottom of Core Config - /opt/tak/CoreConfig.xml
- Locate page /locate only avaliable to global admins for now (look at access later for agency admins)
- Admin creates Locator based off an event title and Sets Ping interval (can be adjusted later).  Link gets created takportal.agency.gov/locate/xyztitle
- Possibly create a custom form editor?  Custom fields, photo upload?, etc?  But for now collect First name, Last name, and message field.
- Displays Copy link, Send SMS (will need backend support), and Email options
- Lost person clicks link and confirmation page displays their coordinates and last updated time.  Remove heavy css to help with minimal cell signal. Notify user to keep page open
- TAK server recieves COTS labeled "Last, First 3/27/26 18:25:15". Additional cots are added per the ping interval.  Data is also displayed in TAK Portal keeping a running log of Coordinates and last update time
- At the end of mission, TAK Portal can archive the log if needed for later