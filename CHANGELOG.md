# Change Log

All notable changes to this project will be documented in this file.  Minor quality improvements or tweaks may not be listed.

Planned features can be accessed [here](docs/roadmap.md)

<!-- 🎉 `New Feature` - -->
<!-- ✨ `Enhancement` - -->
<!-- ✏️ `Documentation` - -->
<!-- 🐛 `Bug Fix` - Fixes issue with -->
<!-- ⬆️ `Dependency` - -->

## Version History

### v1.2.15 - 2/22/26
✨ `Enhancement` - Adds sortable columns to Pending User Requests <br>
✨ `Enhancement` - Changes display of Other / Not Listed agency info on Pending User Requests page and modifies "Approve" button to be a "Review Request" button for "Other"<br>

### v1.2.14 - 2/22/26
✨ `Enhancement` - Modified Pending User Requests page to accept requests inline rather than at the bottom of the page. <br>
🐛 `Bug Fix` - Fixes issue with password field on the pending user requests page not displaying as full width <br>
🐛 `Bug Fix` - Fixes issue with password field on the pending user requests page not validating passwords properly.  Cleaned up logic for the Pending User Requests Page and Users page to behave identically.

### v1.2.13 - 2/22/26
✨ `Enhancement` - Adds an additional dropdown option on the edit user page for converting existing users to global admins. This also in turn hides the global admins from agency admins to protect permission overrides from a lower level.

### v1.2.12 - 2/21/26
🐛 `Bug Fix` - More fixes for updater script

### v1.2.11 - 2/21/26
🐛 `Bug Fix` - Attempts to fix issues with Web UI Updater Failing <br>
✨ `Enhancement` - Request Access page now uses agency abbreviation rather than suffix

### v1.2.10 - 2/21/26
✨ `Enhancement` - Added hCaptcha to the request access page.  A free account can be created at hCaptcha.com and the site/secret keys can be placed in the TAK Portal settings.

### v1.2.9 - 2/21/26
🐛 `Bug Fix` - Fixes issue with updater service not performing all functions for a proper docker update

### v1.2.8 - 2/21/26
✨ `Enhancement` - Modified CSS to improve the UI Updater Functionality

### v1.2.7 - 2/21/26
✨ `Enhancement` - User Request form notifies Agency Admins upon user requests for each agency via email, if no Agency Admin is set or if the agency does not exist, email gets sent to the Global Admin. <br>
🐛 `Bug Fix` - Fixes formatting issues on Request Access page

### v1.2.6 - 2/20/26
🎉 `New Feature` - Version bump to test new auto updater Web UI

### v1.2.5 - 2/20/26
🎉 `New Feature` - Added a "Request Access" page and handling for Global and Agency Admins - Agency Admins can manage their own agency's requests. (More enhancements on this to come soon)<br>
✨ `Enhancement` - Made Dashboard Mutual Aid Banners Clickable for Global Admins <br>

### v1.2.4 - 2/20/26
✨ `Enhancement` - Adds State Wide Group creation for Global Admins with the ability for Agency Admins to assign the group

### v1.2.3 - 2/17/26
✨ `Enhancement` - Adds a state dropdown to agency creation (not currently implemented elsewhere, but here for future planning)

### v1.2.2 - 2/17/26
✨ `Enhancement` - Normalizes usernames to be all lowercase without spaces

### v1.2.1 - 2/17/26
✨ `Enhancement` - Allows for users to be created with a username other than numbers and makes email field optional <br>
🐛 `Bug Fix` - Fixes issue with agency admin groups getting created with a "tak_" prefix

### v1.2.0 - 2/1/26
✨ `Enhancement` - Removes 'Create Users' page and combines it with 'Manage Users' as a single 'Users' page <br>
🐛 `Bug Fix` - Cleans up weird looks with Templates page

### v1.1.51 - 2/1/26
🎉 `New Feature` - Added an 'Email Packet' button to Mutual Aid QR Codes, allowing you to email out the deployment packet to an IC or others without the need to download it first and manually email it.

### v1.1.50 - 1/28/26
✨ `Enhancement` - Group formatting names and CN now adjusted to pass proper attributes such as name and description to TAK <br>
🐛 `Bug Fix` - Fixes issue with changing a group's private settings

### v1.1.49 - 1/26/26
✨ `Enhancement` - Minor Update - Simplified sidebar navigation wording

### v1.1.48 - 1/25/26
✨ `Enhancement` - Removed dash for group naming - groups are now "AGENCY Title" or "County Co Title"

### v1.1.47 - 1/20/26
✨ `Enhancement` - Adds sorting to Groups, Templates, and Mutual Aid. Template creation form order also adjusted to match the order of other pages. <br>
✨ `Enhancement` - Adds "Private" column to Groups <br>
🐛 `Bug Fix` - Fixes issue with incorrect permissions blocking agency admins from editing templates belonging to their agency

### v1.1.46 - 1/20/26
✨ `Enhancement` - Added "Manual Login" button to the Setup My Device page to provide manual cert enrollment instructions for each device type

### v1.1.45 - 1/17/26
✨ `Enhancement` - Updated PDF Layout to include device enrollment instructions

### v1.1.44 - 1/17/26
🐛 `Bug Fix` - Fixes issue with Mutual Aid not setting password properly

### v1.1.43 - 1/17/26
🎉 `New Feature` - Added a "Deployment Packet" in Mutual Aid to provide a PDF document to be used at CP for onboarding arriving assets, not already on the TAK system <br>
🎉 `New Feature` - Added custom settings in Server Settings to define colors and roles for deployment packet

### v1.1.42 - 1/16/26
✨ `Enhancement` - Adds "Role" to manage users columns <br>
✨ `Enhancement` - Allows for reordering / deleting / adding bookmarks<br>
🐛 `Bug Fix` - Fixes issue with using a template and accidentally overwriting a user's agency admin group <br>
🐛 `Bug Fix` - Fixes issue with agency admin groups not appearing properly in the groups list <br>
🐛 `Bug Fix` - Fixes issue with incorrect user counts on Manage Users page for Global Admins

### v1.1.41 - 1/16/26
✨ `Enhancement` - Creating an agency will now auto create a group in authentik for that agency's admins. Existing agencies should be deleted and recreated to get this update. <br>
✨ `Enhancement` - Added ability to assign users to agency admin under the edit user button

### v1.1.40 - 1/15/26
🎉 `New Feature` - Added "Standby" option to Mutual Aid to allow for non-critical, generic user MA instances to be created for operational readiness <br>
🎉 `New Feature` - New Mutual Aid instances can now create a new channel or use an existing one <br>
🐛 `Bug Fix` - Fixes issue with Agency displaying the suffix on templates <br>
🐛 `Bug Fix` - Fixes issue with Agency Templates tab getting hidden from Agency Admins <br>

### v1.1.39 - 1/15/26
✨ `Enhancement` - Updated all email templates to maximize compatibly with various email clients with a primary focus on Outlook and Gmail.

### v1.1.38 - 1/14/26
✨ `Enhancement` - Update to restart script <br>
✨ `Enhancement` - Minor behavior tweaks

### v1.1.37 - 1/13/26
🐛 `Bug Fix` - Fixes issue with SMTP not sending emails when it experiences a TLS cert mismatch.  Email service now ignores TLS errors.

### v1.1.36 - 1/12/26
🐛 `Bug Fix` - Fixes issue with incorrect email conditional formatting <br>
🐛 `Bug Fix` - Fixes issue with incorrect settings format for SMTP `From` Address.  All existing users should remove the quotes around the text in that field <br>
✨ `Enhancement` - Email formatting cleaned up and optimized for readability

### v1.1.35 - 1/12/26
⬆️ `Dependency` - Updated DockerFile to manage certificates for SMTP

### v1.1.34 - 1/12/26
✨ `Enhancement` - Major reduction in loading time for all users performing the "View Members" function on groups

### v1.1.33 - 1/12/26
✨ `Enhancement` - MAJOR reduction in loading time for agency admins navigating to the manage users section.  Load time cut down by 3/4.  Changed logic from looking at username suffixes to looking at authentik user attributes.

### v1.1.32 - 1/12/26
✨ `Enhancement` - Added the ability to make a channel "Private" so that it is hidden from Agency Admins (My use will be sensitive groups and WRITE groups for data feeds from NodeRed)

### v1.1.31 - 1/11/26
✨ `Enhancement` - Added "Color Override" to agency templates so that users created with certain templates would be assigned a special color, different from their agency (ex... SWAT to get a differing color) <br>
✨ `Enhancement` - Adjusted the service for new user emails to reflect the template override color

### v1.1.30 - 1/11/26
✨ `Enhancement` - Added CloudTAK URL to settings and Setup My Device pages <br>
✨ `Enhancement` - Added setting variable to pass TAK Portal Public URL to email templates <br>
✨ `Enhancement` - Updated email templates to default to the TAK Public URL, but fall back to contact TAK Portal Admin if variable isn't set

### v1.1.29 - 1/10/26
🐛 `Bug Fix` - Fixes issue with Agency Templates not appearing in sidebar

### v1.1.28 - 1/10/26
✨ `Enhancement` - Added "Import Configuration" button to the Server Settings

### v1.1.27 - 1/10/26
✨ `Enhancement` - Added caching service for dashboard to speed up page loading times <br>
🐛 `Bug Fix` - Removed CPU and Memory Usage till I can get a more accurate number

### v1.1.26 - 1/10/26
🐛 `Bug Fix` - Fixes issue with not being able to log in on initial install due to authentication being disabled

### v1.1.25 - 1/9/26
✨ `Enhancement` - Updated modal for editing a user

### v1.1.24 - 1/9/26
✨ `Enhancement` - Adds QR button to each user on manage users page <br>
🐛 `Bug Fix` - Fixes issue with Disable/Delete Buttons not working

### v1.1.23 - 1/9/26
🎉 `New Feature` - Added TAK Server Health Stats to Dashboard

### v1.1.22 - 1/9/26
✨ `Enhancement` - Modified Setup My Device Buttons and Behaviors

### v1.1.21 - 1/9/26
🎉 `New Feature` - Added a Scan QR Code Option in the Setup My Device page that creates a short term QR Code login, good for 30 min. <br>
✨ `Enhancement` - Removed the QR Code Generator from sidebar temporarily as it should no longer be needed.

### v1.1.20 - 1/8/26
🎉 `New Feature` - Added a "Setup My Device" page to guide users through the TAK setup process.  This page is not 100% functional and will continue to see updates to bring it to full functionality.

### v1.1.19 - 1/6/26
✨ `Enhancement` - Added argument to navigate to the docker data volume using ./takportal data

### v1.1.18 - 1/6/26
🎉 `New Feature` - Added ability to edit email templates from the Server Settings page

### v1.1.17 - 1/5/26
✨ `Enhancement` - Added Agency Abbreviation, Agency Color, and Badge Number to Email Templates and Email Template Variables <br>
✨ `Enhancement` - Adjusted window width for the sidebar to hide<br>
✨ `Enhancement` - Added Agency Color to the agency table <br>
✏️ `Documentation` - Created email-template-variables.md to track available email variables

### v1.1.16 - 1/5/26
✨ `Enhancement` - Added Agency Color Selection <br>

### v1.1.15 - 1/2/26
🎉 `New Feature` - Added ability to test SMTP configuration <br>
🐛 `Bug Fix` - Removes unneeded Agency Admin Group Setting from Setting Page

### v1.1.14 - 1/1/26
✨ `Enhancement` - All pages now 100% Mobile Friendly <br>
🐛 `Bug Fix` - Fixes issue with Templates not appearing for Creating Users

### v1.1.13 - 1/1/26
✏️ `Documentation` - Addition of Change Log file <br>
🎉 `New Feature` - Adds Update Available pill in sidebar<br>
🐛 `Bug Fix` - Fixes issue with Templates not appearing in Manage Users<br>