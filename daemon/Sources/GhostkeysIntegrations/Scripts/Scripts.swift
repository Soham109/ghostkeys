import Foundation

/// Every AppleScript the module runs. Sources are fixed strings: user input only ever reaches a script as
/// an element of `args` (see `ScriptExecutor`), never by string splicing. Each script targets its app by
/// bundle id and bounds every wait with `with timeout`.
///
/// Error numbers: 9001 nothing to act on, 9002 refused (would lose data / too large), 9003 unsupported.
enum Scripts {

    // MARK: Excel

    enum Excel {
        static let id = "com.microsoft.Excel"

        /// args: {maxCells}. Returns {sheetName, {{address, formula}, ...}} for formula cells in the selection
        /// (clipped to the used range so whole-column selections stay small).
        static let readFormulas = """
        on gk_main(args)
        	set maxCells to item 1 of args
        	tell application id "com.microsoft.Excel"
        		with timeout of 15 seconds
        			if (count of workbooks) = 0 then error "No workbook is open." number 9001
        			set sh to active sheet
        			set r to missing value
        			try
        				set r to intersect range1 (selection) range2 (used range of sh)
        			end try
        			if r is missing value then return {name of sh, {}}
        			set n to count of cells of r
        			if n > maxCells then error "The selection has too many cells (" & n & "). Select fewer cells." number 9002
        			set out to {}
        			repeat with i from 1 to n
        				set c to cell i of r
        				if has formula of c then set end of out to {(get address c), (formula2 of c)}
        			end repeat
        			return {name of sh, out}
        		end timeout
        	end tell
        end gk_main
        """

        /// args: {sheetName, {{address, formula}, ...}}. Returns the number of cells written.
        static let writeFormulas = """
        on gk_main(args)
        	set sheetName to item 1 of args
        	set pairs to item 2 of args
        	tell application id "com.microsoft.Excel"
        		with timeout of 30 seconds
        			set sh to worksheet sheetName of active workbook
        			repeat with p in pairs
        				set pr to contents of p
        				set formula2 of range (item 1 of pr) of sh to (item 2 of pr)
        			end repeat
        			return count of pairs
        		end timeout
        	end tell
        end gk_main
        """

        /// args: {}. Returns the active cell's number format.
        static let readActiveNumberFormat = """
        on gk_main(args)
        	tell application id "com.microsoft.Excel"
        		with timeout of 10 seconds
        			if (count of workbooks) = 0 then error "No workbook is open." number 9001
        			return number format of active cell
        		end timeout
        	end tell
        end gk_main
        """

        /// args: {format}. Applies the number format to the whole selection.
        static let setSelectionNumberFormat = """
        on gk_main(args)
        	set fmt to item 1 of args
        	tell application id "com.microsoft.Excel"
        		with timeout of 15 seconds
        			if (count of workbooks) = 0 then error "No workbook is open." number 9001
        			set number format of selection to fmt
        			return fmt
        		end timeout
        	end tell
        end gk_main
        """

        /// args: {includeText, maxCells}. Blue font for constants, black for formulas. Returns {constants, formulas}.
        static let colorInputsFormulas = """
        on gk_main(args)
        	set includeText to item 1 of args
        	set maxCells to item 2 of args
        	tell application id "com.microsoft.Excel"
        		with timeout of 60 seconds
        			if (count of workbooks) = 0 then error "No workbook is open." number 9001
        			set r to missing value
        			try
        				set r to intersect range1 (selection) range2 (used range of active sheet)
        			end try
        			if r is missing value then return {0, 0}
        			set n to count of cells of r
        			if n > maxCells then error "The selection has too many cells (" & n & "). Select fewer cells." number 9002
        			set constantCount to 0
        			set formulaCount to 0
        			repeat with i from 1 to n
        				set c to cell i of r
        				if has formula of c then
        					set color of font object of c to {0, 0, 0}
        					set formulaCount to formulaCount + 1
        				else
        					set v to value of c
        					set k to class of v
        					if k is real or k is integer or (includeText and k is text and v is not "") then
        						set color of font object of c to {0, 0, 255}
        						set constantCount to constantCount + 1
        					end if
        				end if
        			end repeat
        			return {constantCount, formulaCount}
        		end timeout
        	end tell
        end gk_main
        """

        /// args: {formula, overwrite}. Writes a template into the active cell, refusing a non-empty cell
        /// unless overwrite is true.
        static let insertTemplate = """
        on gk_main(args)
        	set f to item 1 of args
        	set overwrite to item 2 of args
        	tell application id "com.microsoft.Excel"
        		with timeout of 10 seconds
        			if (count of workbooks) = 0 then error "No workbook is open." number 9001
        			set c to active cell
        			if not overwrite then
        				if (has formula of c) or ((value of c) as text) is not "" then error "The active cell is not empty." number 9002
        			end if
        			set formula2 of c to f
        			return f
        		end timeout
        	end tell
        end gk_main
        """

        static let pasteValues = """
        on gk_main(args)
        	tell application id "com.microsoft.Excel"
        		with timeout of 15 seconds
        			if (count of workbooks) = 0 then error "No workbook is open." number 9001
        			paste special selection what paste values
        			return "ok"
        		end timeout
        	end tell
        end gk_main
        """

        static let tracePrecedents = """
        on gk_main(args)
        	tell application id "com.microsoft.Excel"
        		with timeout of 10 seconds
        			if (count of workbooks) = 0 then error "No workbook is open." number 9001
        			show precedents active cell
        			return "ok"
        		end timeout
        	end tell
        end gk_main
        """
    }

    // MARK: Chrome (and Meet inside Chrome)

    enum Chrome {
        static let newTab = """
        on gk_main(args)
        	tell application id "com.google.Chrome"
        		with timeout of 10 seconds
        			if (count of windows) = 0 then
        				make new window
        			else
        				tell front window to make new tab
        			end if
        			return "ok"
        		end timeout
        	end tell
        end gk_main
        """

        static let closeTab = """
        on gk_main(args)
        	tell application id "com.google.Chrome"
        		with timeout of 10 seconds
        			if (count of windows) = 0 then error "No Chrome window is open." number 9001
        			close active tab of front window
        			return "ok"
        		end timeout
        	end tell
        end gk_main
        """

        /// args: {step}; step is +1 or -1, wraps around.
        static let stepTab = """
        on gk_main(args)
        	set d to item 1 of args
        	tell application id "com.google.Chrome"
        		with timeout of 10 seconds
        			if (count of windows) = 0 then error "No Chrome window is open." number 9001
        			set w to front window
        			set n to count of tabs of w
        			set j to ((active tab index of w) - 1 + d) mod n
        			if j < 0 then set j to j + n
        			set active tab index of w to j + 1
        			return j + 1
        		end timeout
        	end tell
        end gk_main
        """

        static let duplicateTab = """
        on gk_main(args)
        	tell application id "com.google.Chrome"
        		with timeout of 10 seconds
        			if (count of windows) = 0 then error "No Chrome window is open." number 9001
        			set w to front window
        			set u to URL of active tab of w
        			tell w to make new tab with properties {URL:u}
        			return u
        		end timeout
        	end tell
        end gk_main
        """

        /// Returns {title, url} of the active tab.
        static let activeTabInfo = """
        on gk_main(args)
        	tell application id "com.google.Chrome"
        		with timeout of 10 seconds
        			if (count of windows) = 0 then error "No Chrome window is open." number 9001
        			set t to active tab of front window
        			return {title of t, URL of t}
        		end timeout
        	end tell
        end gk_main
        """

        static let moveTabToNewWindow = """
        on gk_main(args)
        	tell application id "com.google.Chrome"
        		with timeout of 10 seconds
        			if (count of windows) = 0 then error "No Chrome window is open." number 9001
        			set w to front window
        			if (count of tabs of w) < 2 then error "This is the only tab in its window." number 9002
        			set t to active tab of w
        			set u to URL of t
        			close t
        			set w2 to make new window
        			set URL of active tab of w2 to u
        			return u
        		end timeout
        	end tell
        end gk_main
        """

        /// Returns {{windowId, tabIndex, url, isActiveTab, windowIndex}, ...} for every tab.
        static let listTabs = """
        on gk_main(args)
        	tell application id "com.google.Chrome"
        		with timeout of 10 seconds
        			set out to {}
        			repeat with w in (every window)
        				set wid to id of w
        				set widx to index of w
        				set ai to active tab index of w
        				set n to count of tabs of w
        				repeat with i from 1 to n
        					set end of out to {wid, i, (URL of tab i of w), (i = ai), widx}
        				end repeat
        			end repeat
        			return out
        		end timeout
        	end tell
        end gk_main
        """

        /// args: {windowId, tabIndex}. Makes that tab active and its window frontmost within Chrome.
        static let focusTab = """
        on gk_main(args)
        	set wid to item 1 of args
        	set ti to item 2 of args
        	tell application id "com.google.Chrome"
        		with timeout of 10 seconds
        			set w to window id wid
        			set active tab index of w to ti
        			set index of w to 1
        			return "ok"
        		end timeout
        	end tell
        end gk_main
        """
    }

    // MARK: Arc

    enum Arc {
        static let activeTabInfo = """
        on gk_main(args)
        	tell application id "company.thebrowser.Browser"
        		with timeout of 10 seconds
        			if (count of windows) = 0 then error "No Arc window is open." number 9001
        			set t to active tab of front window
        			return {title of t, URL of t}
        		end timeout
        	end tell
        end gk_main
        """

        static let duplicateTab = """
        on gk_main(args)
        	tell application id "company.thebrowser.Browser"
        		with timeout of 10 seconds
        			if (count of windows) = 0 then error "No Arc window is open." number 9001
        			set u to URL of active tab of front window
        			tell front window to make new tab with properties {URL:u}
        			return u
        		end timeout
        	end tell
        end gk_main
        """
    }

    // MARK: Safari

    enum Safari {
        static let newTab = """
        on gk_main(args)
        	tell application id "com.apple.Safari"
        		with timeout of 10 seconds
        			if (count of windows) = 0 then
        				make new document
        			else
        				tell front window to set current tab to (make new tab)
        			end if
        			return "ok"
        		end timeout
        	end tell
        end gk_main
        """

        static let closeTab = """
        on gk_main(args)
        	tell application id "com.apple.Safari"
        		with timeout of 10 seconds
        			if (count of windows) = 0 then error "No Safari window is open." number 9001
        			close current tab of front window
        			return "ok"
        		end timeout
        	end tell
        end gk_main
        """

        /// args: {step}.
        static let stepTab = """
        on gk_main(args)
        	set d to item 1 of args
        	tell application id "com.apple.Safari"
        		with timeout of 10 seconds
        			if (count of windows) = 0 then error "No Safari window is open." number 9001
        			set w to front window
        			set n to count of tabs of w
        			set j to ((index of current tab of w) - 1 + d) mod n
        			if j < 0 then set j to j + n
        			set current tab of w to tab (j + 1) of w
        			return j + 1
        		end timeout
        	end tell
        end gk_main
        """

        static let duplicateTab = """
        on gk_main(args)
        	tell application id "com.apple.Safari"
        		with timeout of 10 seconds
        			if (count of windows) = 0 then error "No Safari window is open." number 9001
        			set w to front window
        			set u to URL of current tab of w
        			tell w to set current tab to (make new tab with properties {URL:u})
        			return u
        		end timeout
        	end tell
        end gk_main
        """

        static let activeTabInfo = """
        on gk_main(args)
        	tell application id "com.apple.Safari"
        		with timeout of 10 seconds
        			if (count of windows) = 0 then error "No Safari window is open." number 9001
        			set t to current tab of front window
        			return {name of t, URL of t}
        		end timeout
        	end tell
        end gk_main
        """

        static let moveTabToNewWindow = """
        on gk_main(args)
        	tell application id "com.apple.Safari"
        		with timeout of 10 seconds
        			if (count of windows) = 0 then error "No Safari window is open." number 9001
        			set w to front window
        			if (count of tabs of w) < 2 then error "This is the only tab in its window." number 9002
        			set u to URL of current tab of w
        			close current tab of w
        			make new document with properties {URL:u}
        			return u
        		end timeout
        	end tell
        end gk_main
        """
    }

    // MARK: Music and Spotify (same verbs, different targets)

    enum Player {
        static func playPause(_ id: String) -> String { simple(id, "playpause") }
        static func next(_ id: String) -> String { simple(id, "next track") }
        static func previous(_ id: String) -> String { simple(id, "previous track") }

        private static func simple(_ id: String, _ verb: String) -> String {
            """
            on gk_main(args)
            	tell application id "\(id)"
            		with timeout of 10 seconds
            			\(verb)
            			return "ok"
            		end timeout
            	end tell
            end gk_main
            """
        }

        /// args: {delta}. Returns the new volume 0...100.
        static func volume(_ id: String) -> String {
            """
            on gk_main(args)
            	set d to item 1 of args
            	tell application id "\(id)"
            		with timeout of 10 seconds
            			set v to (sound volume) + d
            			if v > 100 then set v to 100
            			if v < 0 then set v to 0
            			set sound volume to v
            			return v
            		end timeout
            	end tell
            end gk_main
            """
        }

        /// Returns {} when stopped, else {name, artist}.
        static func nowPlaying(_ id: String) -> String {
            """
            on gk_main(args)
            	tell application id "\(id)"
            		with timeout of 10 seconds
            			if player state is stopped then return {}
            			set t to current track
            			return {name of t, artist of t}
            		end timeout
            	end tell
            end gk_main
            """
        }

        static let musicLike = """
        on gk_main(args)
        	tell application id "com.apple.Music"
        		with timeout of 10 seconds
        			if player state is stopped then error "Nothing is playing." number 9001
        			set t to current track
        			set favorited of t to true
        			return {name of t, artist of t}
        		end timeout
        	end tell
        end gk_main
        """
    }

    // MARK: Finder

    enum Finder {
        /// The folder shown in the front Finder window, or the Desktop when no window is open.
        private static let frontTarget = """
        			if (count of Finder windows) > 0 then
        				set t to target of front Finder window
        			else
        				set t to desktop
        			end if
        """

        static let newFolderHere = """
        on gk_main(args)
        	tell application id "com.apple.finder"
        		with timeout of 10 seconds
        \(frontTarget)
        			set f to make new folder at t
        			select f
        			return POSIX path of (f as alias)
        		end timeout
        	end tell
        end gk_main
        """

        static let revealDesktop = """
        on gk_main(args)
        	tell application id "com.apple.finder"
        		with timeout of 10 seconds
        			if (count of Finder windows) = 0 then make new Finder window
        			set target of front Finder window to desktop
        			return POSIX path of (desktop as alias)
        		end timeout
        	end tell
        end gk_main
        """

        /// Returns a list of POSIX paths: the selection, or the front folder when nothing is selected.
        static let selectionPaths = """
        on gk_main(args)
        	tell application id "com.apple.finder"
        		with timeout of 10 seconds
        			set s to selection
        			set out to {}
        			if (count of s) = 0 then
        \(frontTarget)
        				set end of out to POSIX path of (t as alias)
        			else
        				repeat with x in s
        					set end of out to POSIX path of (x as alias)
        				end repeat
        			end if
        			return out
        		end timeout
        	end tell
        end gk_main
        """

        static let frontFolderPath = """
        on gk_main(args)
        	tell application id "com.apple.finder"
        		with timeout of 10 seconds
        \(frontTarget)
        			return POSIX path of (t as alias)
        		end timeout
        	end tell
        end gk_main
        """
    }

    // MARK: PowerPoint

    enum PowerPoint {
        static let start = """
        on gk_main(args)
        	tell application id "com.microsoft.Powerpoint"
        		with timeout of 10 seconds
        			if (count of presentations) = 0 then error "No presentation is open." number 9001
        			run slide show slide show settings of active presentation
        			return "ok"
        		end timeout
        	end tell
        end gk_main
        """

        /// args: {step}. Returns "not-presenting" when no slide show is running.
        static let step = """
        on gk_main(args)
        	set d to item 1 of args
        	tell application id "com.microsoft.Powerpoint"
        		with timeout of 10 seconds
        			if (count of slide show windows) = 0 then return "not-presenting"
        			set v to slideshow view of slide show window 1
        			if d > 0 then
        				go to next slide v
        			else
        				go to previous slide v
        			end if
        			return "ok"
        		end timeout
        	end tell
        end gk_main
        """

        static let blackScreen = """
        on gk_main(args)
        	tell application id "com.microsoft.Powerpoint"
        		with timeout of 10 seconds
        			if (count of slide show windows) = 0 then error "No slide show is running." number 9001
        			set v to slideshow view of slide show window 1
        			if slide state of v is slide show state black screen then
        				set slide state of v to slide show state running
        				return "running"
        			else
        				set slide state of v to slide show state black screen
        				return "black"
        			end if
        		end timeout
        	end tell
        end gk_main
        """
    }

    // MARK: Keynote

    enum Keynote {
        static let start = """
        on gk_main(args)
        	tell application id "com.apple.Keynote"
        		with timeout of 10 seconds
        			if (count of documents) = 0 then error "No presentation is open." number 9001
        			start front document
        			return "ok"
        		end timeout
        	end tell
        end gk_main
        """

        /// args: {step}. Returns "not-presenting" when no slideshow is playing.
        static let step = """
        on gk_main(args)
        	set d to item 1 of args
        	tell application id "com.apple.Keynote"
        		with timeout of 10 seconds
        			if not playing then return "not-presenting"
        			if d > 0 then
        				show next
        			else
        				show previous
        			end if
        			return "ok"
        		end timeout
        	end tell
        end gk_main
        """

        static let isPlaying = """
        on gk_main(args)
        	tell application id "com.apple.Keynote"
        		with timeout of 10 seconds
        			return playing
        		end timeout
        	end tell
        end gk_main
        """
    }

    /// Every script source, for compile checks.
    static var all: [(String, String)] {
        let players = ["com.apple.Music", "com.spotify.client"].flatMap { id in
            [("\(id) playPause", Player.playPause(id)), ("\(id) next", Player.next(id)),
             ("\(id) previous", Player.previous(id)), ("\(id) volume", Player.volume(id)),
             ("\(id) nowPlaying", Player.nowPlaying(id))]
        }
        return [
            ("excel.readFormulas", Excel.readFormulas), ("excel.writeFormulas", Excel.writeFormulas),
            ("excel.readActiveNumberFormat", Excel.readActiveNumberFormat),
            ("excel.setSelectionNumberFormat", Excel.setSelectionNumberFormat),
            ("excel.colorInputsFormulas", Excel.colorInputsFormulas), ("excel.insertTemplate", Excel.insertTemplate),
            ("excel.pasteValues", Excel.pasteValues), ("excel.tracePrecedents", Excel.tracePrecedents),
            ("chrome.newTab", Chrome.newTab), ("chrome.closeTab", Chrome.closeTab), ("chrome.stepTab", Chrome.stepTab),
            ("chrome.duplicateTab", Chrome.duplicateTab), ("chrome.activeTabInfo", Chrome.activeTabInfo),
            ("chrome.moveTabToNewWindow", Chrome.moveTabToNewWindow), ("chrome.listTabs", Chrome.listTabs),
            ("chrome.focusTab", Chrome.focusTab),
            ("arc.activeTabInfo", Arc.activeTabInfo), ("arc.duplicateTab", Arc.duplicateTab),
            ("safari.newTab", Safari.newTab), ("safari.closeTab", Safari.closeTab), ("safari.stepTab", Safari.stepTab),
            ("safari.duplicateTab", Safari.duplicateTab), ("safari.activeTabInfo", Safari.activeTabInfo),
            ("safari.moveTabToNewWindow", Safari.moveTabToNewWindow),
            ("music.like", Player.musicLike),
            ("finder.newFolderHere", Finder.newFolderHere), ("finder.revealDesktop", Finder.revealDesktop),
            ("finder.selectionPaths", Finder.selectionPaths), ("finder.frontFolderPath", Finder.frontFolderPath),
            ("powerpoint.start", PowerPoint.start), ("powerpoint.step", PowerPoint.step),
            ("powerpoint.blackScreen", PowerPoint.blackScreen),
            ("keynote.start", Keynote.start), ("keynote.step", Keynote.step), ("keynote.isPlaying", Keynote.isPlaying),
        ] + players
    }
}
